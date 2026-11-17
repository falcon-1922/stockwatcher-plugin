// The person's own portfolios: "this is my portfolio: 10 AAPL, 5 MSFT, 20 nvidia" saves it,
// "show my portfolio" brings it back. Several can be kept by name ("my retirement portfolio").
// With quantities, blocks are sized by what each position is worth; without, by market value.
import { lookupHelpers, stockOf, splitQuery } from './resolve.mjs';
import { TO_GICS } from './indices.mjs';

const KIND = '(?:portfolio|holdings|positions|stocks|shares|investments)';
const NOT_NAMES = new Set(['own', 'current', 'whole', 'entire', 'stock', 'new', 'full', 'real', 'personal', 'investment', 'actual', 'updated']);
const MY = new RegExp('\\bmy\\s+(?:([a-z][\\w-]{0,20})\\s+)?' + KIND + '\\b', 'i');
const SAYS = /^\s*(?:is|are|:|=|-|–|includes?|contains?|consists of|now is|looks like)\s*(.+)$/i;

// → null, or { name, phrase, content } where content is null for "show my portfolio".
export function parseMine(q) {
  const s = String(q || '');
  let m = /\bi\s+(?:own|hold|have)\s+(.+)$/i.exec(s);                    // "I own 10 AAPL and 5 MSFT"
  if (m && /\d|[A-Z]{2,}/.test(m[1])) return { name: 'default', phrase: m[0], content: m[1] };
  m = new RegExp('\\bsave\\s+(.+?)\\s+as\\s+my\\s+(?:([a-z][\\w-]{0,20})\\s+)?' + KIND, 'i').exec(s);  // "save AAPL, MSFT as my portfolio"
  if (m) return { name: nameOf(m[2]), phrase: m[0], content: m[1] };
  m = MY.exec(s);
  if (!m) return null;
  const after = SAYS.exec(s.slice(m.index + m[0].length));
  return { name: nameOf(m[1]), phrase: after ? s.slice(m.index) : m[0], content: after ? after[1] : null };
}
const nameOf = n => (!n || NOT_NAMES.has(n.toLowerCase()) ? 'default' : n.toLowerCase());
export const titleOf = name => (name === 'default' ? 'My portfolio' : 'My ' + name + ' portfolio');

// "10 AAPL, MSFT x5, 20 shares of nvidia and 3.5 BRK-B" → [{ y, qty }], plus words not found.
export function parseItems(text, index) {
  const { bySym, findByName } = lookupHelpers(index);
  const items = [], unknown = [];
  for (const raw of splitQuery(String(text || '').replace(/\.$/, ''))) {
    let qty = null, what = raw.trim();
    let m = /^(\d+(?:[.,]\d+)?)\s*(?:x\s*)?(?:shares?\s+(?:of\s+)?|units?\s+(?:of\s+)?)?(.+)$/i.exec(what);
    if (m) { qty = parseFloat(m[1].replace(',', '.')); what = m[2]; }
    else if ((m = /^(.+?)\s*[:x×]?\s*(\d+(?:[.,]\d+)?)\s*(?:shares?|units?)?$/i.exec(what))) { qty = parseFloat(m[2].replace(',', '.')); what = m[1]; }
    what = what.replace(/^\$/, '').trim();
    const sym = what.toUpperCase().replace('/', '-');
    let y = null;
    if (bySym.has(sym)) y = sym;
    else if (/^[A-Z0-9-]{1,10}\.[A-Z]{1,3}$/.test(sym)) y = sym;          // foreign listing, e.g. 9984.T
    else { const row = findByName(what); if (row) y = row[0]; }
    if (y) items.push({ y, qty }); else unknown.push(raw.trim());
  }
  return { items, unknown };
}

// Saved items → a dashboard section, grouped by sector.
export function mineSection(name, items, index) {
  const { bySym } = lookupHelpers(index);
  const bySector = new Map();
  for (const it of items) {
    const row = bySym.get(it.y);
    const st = row ? stockOf(row) : { y: it.y, t: it.y.split('.')[0], n: it.y, x: it.y.split('.')[1] || 'US', c: '' };
    const sector = row ? TO_GICS[row[2]] || 'Other' : 'Other';
    if (!bySector.has(sector)) bySector.set(sector, []);
    bySector.get(sector).push(it.qty ? { ...st, qty: it.qty, x: it.qty.toLocaleString('en-US') + ' shares' } : st);
  }
  const groups = [...bySector.entries()].map(([g, stocks]) => ({ name: g, note: '', stocks }));
  const withQty = items.some(i => i.qty);
  return {
    id: 'mine-' + name.replace(/[^a-z0-9-]/g, ''), title: titleOf(name), groups, sizeBy: withQty ? 'qty' : undefined,
    blurb: items.length + ' holdings, saved on this computer.' + (withQty ? ' Block size is what each position is worth now.' : ''),
  };
}
