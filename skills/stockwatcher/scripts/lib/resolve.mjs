// Turns what a person types ("healthcare", "nvidia, amd and tesla", "banks and insurance",
// "chips") into dashboard sections, using only local data: curated themes, a synonym table
// over Nasdaq's sector/industry labels, ticker symbols and company names. No model calls.
//
// Index rows: [symbol, name, sector, industry, marketCapUSD, country]
import { TO_GICS } from './indices.mjs';

const SYM = 0, NAME = 1, SECTOR = 2, IND = 3, CAP = 4;

// Everyday words → Nasdaq sector ("S:") or industry pattern ("I:"). Longest phrase wins.
export const SYNONYMS = [
  [['healthcare', 'health care', 'health', 'medical', 'healthcare stocks'], 'Health care', ['S:Health Care']],
  [['pharma', 'big pharma', 'pharmaceutical', 'pharmaceuticals', 'drugmakers', 'drug makers', 'drugs'], 'Pharmaceuticals', ['I:Pharmaceutical|Medicinal Chemicals']],
  [['biotech', 'biotechnology', 'biotechs'], 'Biotechnology', ['I:^Biotechnology: (Biological|Pharmaceutical|In Vitro|Commercial Physical)']],
  [['medtech', 'medical devices', 'medical device', 'medical equipment', 'medical instruments'], 'Medical devices', ['I:Medical/Dental Instruments|Medical Specialities|Medical Electronics|Electromedical|Ophthalmic']],
  [['hospitals', 'health insurers', 'managed care', 'health services'], 'Health services', ['I:Hospital|Medical/Nursing Services|Misc Health|Accident &Health']],
  [['tech', 'technology', 'tech stocks', 'technology stocks'], 'Technology', ['S:Technology']],
  [['software', 'saas', 'cloud software', 'enterprise software'], 'Software', ['I:Computer Software']],
  [['semiconductors', 'semiconductor'], 'Semiconductors', ['I:^Semiconductors$']],
  [['hardware', 'computers', 'pc makers', 'servers'], 'Computer hardware', ['I:Computer Manufacturing|Computer peripheral|Computer Communications']],
  [['it services', 'internet', 'internet stocks', 'payments', 'fintech'], 'Internet and IT services', ['I:EDP Services|Programming Data Processing']],
  [['banks', 'bank', 'banking', 'big banks', 'regional banks'], 'Banks', ['I:Banks|Savings Institutions']],
  [['insurance', 'insurers', 'insurance companies'], 'Insurance', ['I:Insur']],
  [['finance', 'financials', 'financial', 'financial services'], 'Financials', ['S:Finance']],
  [['asset managers', 'brokers', 'investment banks', 'exchanges', 'wall street'], 'Brokers and asset managers', ['I:Investment Bankers|Investment Managers|Finance/Investors Services']],
  [['energy', 'energy stocks'], 'Energy', ['S:Energy']],
  [['oil', 'gas', 'oil and gas', 'oil & gas', 'petroleum', 'oil majors', 'big oil'], 'Oil and gas', ['I:Integrated oil|Oil & Gas Production|Oil Refining|Oilfield Services|Oil/Gas Transmission']],
  [['coal'], 'Coal', ['I:Coal Mining']],
  [['utilities', 'utility', 'power', 'electricity', 'power companies'], 'Utilities', ['S:Utilities']],
  [['water'], 'Water', ['I:Water Supply|Water Sewer']],
  [['real estate', 'property', 'properties', 'landlords'], 'Real estate', ['S:Real Estate']],
  [['reits', 'reit'], 'REITs', ['I:Real Estate Investment Trusts']],
  [['homebuilders', 'housing', 'home builders', 'homebuilding'], 'Homebuilders', ['I:Homebuilding|Building Materials|Building Products']],
  [['consumer', 'consumer stocks'], 'Consumer', ['S:Consumer Discretionary', 'S:Consumer Staples']],
  [['consumer staples', 'staples', 'defensive stocks'], 'Consumer staples', ['S:Consumer Staples']],
  [['consumer discretionary', 'discretionary'], 'Consumer discretionary', ['S:Consumer Discretionary']],
  [['retail', 'retailers', 'shops', 'stores', 'ecommerce', 'e-commerce'], 'Retail', ['I:Retail|Department|Stores|Catalog/Specialty|Food Chains']],
  [['restaurants', 'fast food', 'restaurant'], 'Restaurants', ['I:Restaurants']],
  [['food', 'beverages', 'beverage', 'drinks', 'food and beverage', 'food & beverage', 'snacks'], 'Food and drink', ['I:Packaged Foods|Beverages|Specialty Foods|Meat/Poultry|Food Distributors|Farming']],
  [['tobacco', 'cigarettes'], 'Tobacco', ['I:Tobacco']],
  [['apparel', 'fashion', 'clothing', 'shoes', 'luxury'], 'Apparel and shoes', ['I:Apparel|Clothing|Shoe|Garments|Textiles']],
  [['cosmetics', 'beauty', 'household products', 'personal care'], 'Household and personal care', ['I:Package Goods/Cosmetics']],
  [['travel', 'hotels', 'cruise', 'cruises', 'leisure', 'casinos', 'gaming'], 'Travel and leisure', ['I:Hotels|Amusement|Recreational']],
  [['media', 'entertainment', 'streaming', 'movies', 'broadcasting'], 'Media', ['I:Movies|Broadcasting|Cable|Publishing|Newspapers|Advertising']],
  [['telecom', 'telecoms', 'telecommunications', 'telcos', 'wireless', '5g'], 'Telecoms', ['S:Telecommunications']],
  [['industrials', 'industrial', 'industry', 'manufacturing', 'machinery'], 'Industrials', ['S:Industrials']],
  [['aerospace', 'aircraft', 'aviation', 'space'], 'Aerospace', ['I:Aerospace']],
  [['autos', 'auto', 'cars', 'carmakers', 'car makers', 'automakers', 'ev', 'evs', 'electric vehicles', 'automotive'], 'Cars and parts', ['I:Auto Manufacturing|Motor Vehicles|Auto Parts']],
  [['transport', 'transportation', 'logistics', 'shipping', 'freight', 'railroads', 'trucking', 'airlines'], 'Transport', ['I:Air Freight|Railroads|Trucking|Marine Transportation|Integrated Freight|Transportation Services']],
  [['construction', 'engineering', 'infrastructure'], 'Construction and engineering', ['I:Engineering & Construction|Water Sewer Pipeline|General Bldg']],
  [['chemicals', 'chemical'], 'Chemicals', ['I:Chemicals|Paints']],
  [['materials', 'basic materials', 'commodities'], 'Materials', ['S:Basic Materials']],
  [['mining', 'miners', 'metals', 'copper', 'lithium'], 'Mining and metals', ['I:Metal Mining|Other Metals|Steel|Aluminum|Precious Metals|Mining & Quarrying']],
  [['gold', 'silver', 'precious metals', 'gold miners'], 'Precious metals', ['I:Precious Metals']],
  [['steel'], 'Steel', ['I:Steel']],
  [['agriculture', 'farming', 'fertilizer', 'fertiliser'], 'Agriculture', ['I:Agricultural Chemicals|Farming']],
];

// Words that carry no meaning for the search. Removed before matching.
const FILLER = new Set(('i want to see show me give display list please the a an of in on for some all any my our stocks stock '
  + 'shares share companies company names sector sectors industry industries related to about like with top biggest largest '
  + 'major leading best main listed us american dashboard watch track see me can you also plus just only those these that').split(' '));

export function normalise(s) {
  return String(s || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9&.\- ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function stripFiller(s) {
  return s.split(' ').filter(w => w && !FILLER.has(w)).join(' ');
}

// "nvidia, amd and tesla" → ["nvidia", "amd", "tesla"]
// In a researched list (strict) only lower-case words join items: "OR" and "AND" there are
// tickers (PTT Oil and Retail is OR.BK).
export function splitQuery(q, strict = false) {
  const re = strict ? /\s*(?:,|;|\+|\/|&(?!\w)|\band\b|\bor\b|\bplus\b|\bvs\.?|\bversus\b)\s*/ : /\s*(?:,|;|\+|\/|&(?!\w)|\band\b|\bor\b|\bplus\b|\bvs\.?|\bversus\b)\s*/i;
  return String(q || '').split(re).map(s => s.trim()).filter(Boolean);
}

const wordRe = phrase => new RegExp('(^| )' + phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + 's?( |$)');

let synCache = null;
function synonymList() {
  if (synCache) return synCache;
  synCache = [];
  for (const [phrases, title, filters] of SYNONYMS) for (const p of phrases) synCache.push({ phrase: p, re: wordRe(p), title, filters });
  synCache.sort((a, b) => b.phrase.length - a.phrase.length);
  return synCache;
}

// "saudi market heat map" is not the S&P 500: its everyday aliases ("market heat map", "the
// market") stand back when the words name a market outside the US.
const SP500_EXPLICIT = /s&p|spx|spy|sp ?500|sp index|standard/;
function themeFor(text, themes) {
  const foreign = marketSuffix(text);
  for (const t of themes) {
    for (const a of t.aliases) {
      if (foreign && t.id === 'sp500' && !SP500_EXPLICIT.test(a)) continue;
      if (wordRe(a).test(text)) return { theme: t, alias: a };
    }
  }
  return null;
}

const reCache = new Map();
function matchesFilter(row, f) {
  if (f.startsWith('S:')) return row[SECTOR] === f.slice(2);
  let re = reCache.get(f);
  if (!re) { re = new RegExp(f.slice(2), 'i'); reCache.set(f, re); }
  return re.test(row[IND]);
}

export function prettyIndustry(ind) {
  const s = String(ind).trim().replace(/^(Biotechnology|Computer Software): /, '').replace(/\s*\(.*?\)\s*/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// capAt: [market value, the price it was worked out at], for carrying the value forward with
// the live price. It applies only while cap is still that value (a researched size replaces it).
export const stockOf = row => ({ y: row[SYM], t: row[SYM], n: row[NAME], x: 'US', c: 'USD', cap: row[CAP], ...(row[6] > 0 ? { capAt: [row[CAP], row[6]] } : {}) });

// Symbol map and name search for one index, built once per index.
const helpers = new WeakMap();
export function lookupHelpers(index) {
  let h = helpers.get(index);
  if (!h) {
    const bySym = new Map(index.map(r => [r[SYM], r]));
    let names = null;                    // normalised company names, made on first use
    h = { bySym, stockOf, names: () => names || (names = index.map(r => normalise(r[NAME]))), findByName: text => findByName(stripFiller(normalise(text)), index) };
    helpers.set(index, h);
  }
  return h;
}

// Rows matching any of the filters, grouped by industry, biggest first.
export function sectionFromFilters(index, filters, title, opts = {}) {
  const perGroup = opts.perGroup || 10, maxGroups = opts.maxGroups || 6, minCap = opts.minCap ?? 1e9;
  let rows = index.filter(r => filters.some(f => matchesFilter(r, f)));
  // One line per company: drop the smaller share class (GOOG next to GOOGL, BRK-A next to BRK-B).
  const names = new Set();
  rows = rows.filter(r => { const k = r[NAME].toLowerCase(); if (names.has(k)) return false; names.add(k); return true; });
  if (!rows.length) return null;
  const big = rows.filter(r => r[CAP] >= minCap);
  rows = big.length >= 5 ? big : rows;
  const byInd = new Map();
  for (const r of rows) {
    const k = prettyIndustry(r[IND]);
    if (!byInd.has(k)) byInd.set(k, []);
    byInd.get(k).push(r);
  }
  const groups = [...byInd.entries()]
    .map(([name, rs]) => ({ name, rs: rs.slice(0, perGroup), total: rs.reduce((a, r) => a + r[CAP], 0) }))
    .sort((a, b) => b.total - a.total).slice(0, maxGroups)
    .map(g => ({ name: g.name, note: '', stocks: g.rs.map(stockOf) }));
  return { title, blurb: '', groups };
}

// An index: every member, one line per company, grouped by sector, biggest first.
function sectionFromIndex(theme, bySym) {
  const bySector = new Map(), names = new Set();
  for (const [sym, sector] of theme.members) {
    const row = bySym.get(sym);
    const stock = row ? stockOf(row) : { y: sym, t: sym, n: sym, x: 'US', c: 'USD' };
    const key = normalise(stock.n);
    if (names.has(key)) continue;              // GOOG next to GOOGL, FOX next to FOXA
    names.add(key);
    const s = sector || (row && TO_GICS[row[SECTOR]]) || 'Other';
    if (!bySector.has(s)) bySector.set(s, []);
    bySector.get(s).push(stock);
  }
  const total = list => list.reduce((a, st) => a + (st.cap || 0), 0);
  const groups = [...bySector.entries()]
    .map(([name, stocks]) => ({ name, note: '', stocks: stocks.sort((a, b) => (b.cap || 0) - (a.cap || 0)) }))
    .sort((a, b) => total(b.stocks) - total(a.stocks));
  return { id: theme.id, title: theme.title, blurb: theme.blurb, groups, big: true };
}

function sectionFromTheme(theme, bySym) {
  if (theme.sizeBy === 'indexWeight') {
    return { ...theme, groups: theme.groups.map(g => ({ ...g,
      stocks: g.stocks.map(([y, t, n, x, c, indexWeight]) => ({ y, t, n, x, c, indexWeight }))
    })) };
  }
  if (theme.members) return sectionFromIndex(theme, bySym);
  return {
    id: theme.id, title: theme.title, blurb: theme.blurb,
    groups: theme.groups.map(g => ({
      name: g.name, note: g.note || '',
      stocks: g.stocks.map(s => {
        if (Array.isArray(s)) return { y: s[0], t: s[1], n: s[2], x: s[3], c: s[4] };
        const row = bySym.get(s);
        return row ? stockOf(row) : { y: s, t: s, n: s, x: 'US', c: 'USD' };
      }),
    })),
  };
}

function findByName(text, index) {
  if (text.length < 3) return null;
  const re = wordRe(text), names = lookupHelpers(index).names();
  for (let i = 0; i < index.length; i++) {   // index is sorted by market value: biggest match wins
    const n = names[i];
    if (n === text || n.startsWith(text + ' ') || re.test(n)) return index[i];
  }
  return null;
}

// Companies outside the US list that a built-in index names ("lukoil", "siemens"): found by
// name among its members, so a small model never researches (and guesses) them.
function findInThemes(text, themes) {
  if (text.length < 3) return null;
  const re = wordRe(text);
  for (const t of themes) {
    if (!Array.isArray(t.groups)) continue;
    for (const g of t.groups) for (const s of g.stocks || []) {
      if (!Array.isArray(s) || !s[2]) continue;
      const n = normalise(s[2]);
      if (n === text || n.startsWith(text + ' ') || re.test(n)) return { y: s[0], t: s[1], n: s[2], x: s[3], c: s[4] };
    }
  }
  return null;
}

// Fuzzy fallback: every meaningful word of the text appears in an industry label.
function industriesLike(text, index) {
  const words = text.split(' ').filter(w => w.length >= 4).map(w => w.replace(/(ies|es|s)$/, ''));
  if (!words.length) return [];
  const labels = new Set();
  for (const r of index) {
    const l = r[IND].toLowerCase();
    if (words.every(w => l.includes(w))) labels.add(r[IND]);
  }
  return [...labels];
}

const slug = s => normalise(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section';

// Yahoo exchange suffix → [exchange, trading currency], for listings outside the US.
const SUFFIX = {
  T: ['Tokyo', 'JPY'], HK: ['Hong Kong', 'HKD'], DE: ['Xetra', 'EUR'], F: ['Frankfurt', 'EUR'], PA: ['Paris', 'EUR'],
  AS: ['Amsterdam', 'EUR'], MI: ['Milan', 'EUR'], MC: ['Madrid', 'EUR'], BR: ['Brussels', 'EUR'], L: ['London', 'GBp'],
  SW: ['Swiss', 'CHF'], ST: ['Stockholm', 'SEK'], CO: ['Copenhagen', 'DKK'], OL: ['Oslo', 'NOK'], HE: ['Helsinki', 'EUR'],
  KS: ['Korea', 'KRW'], KQ: ['Kosdaq', 'KRW'], TW: ['Taiwan', 'TWD'], TWO: ['Taipei OTC', 'TWD'], SS: ['Shanghai', 'CNY'],
  SZ: ['Shenzhen', 'CNY'], NS: ['NSE India', 'INR'], BO: ['BSE India', 'INR'], TO: ['Toronto', 'CAD'], V: ['TSX Venture', 'CAD'],
  AX: ['ASX', 'AUD'], SA: ['B3', 'BRL'], MX: ['Mexico', 'MXN'], SI: ['Singapore', 'SGD'], TA: ['Tel Aviv', 'ILS'],
  ME: ['Moscow', 'RUB'],
  BK: ['Thailand (SET)', 'THB'], SR: ['Saudi (Tadawul)', 'SAR'], JK: ['Jakarta', 'IDR'], KL: ['Bursa Malaysia', 'MYR'],
  PS: ['Philippines', 'PHP'], NZ: ['New Zealand', 'NZD'], JO: ['Johannesburg', 'ZAc'], IS: ['Istanbul', 'TRY'],
  QA: ['Qatar', 'QAR'], AE: ['Dubai', 'AED'], KW: ['Kuwait', 'KWF'], CA: ['Cairo', 'EGP'],
  BA: ['Buenos Aires', 'ARS'], SN: ['Santiago', 'CLP'], LM: ['Lima', 'PEN'], CL: ['Colombia', 'COP'],
  WA: ['Warsaw', 'PLN'], PR: ['Prague', 'CZK'], BD: ['Budapest', 'HUF'], VI: ['Vienna', 'EUR'], LS: ['Lisbon', 'EUR'],
  IR: ['Dublin', 'EUR'], AT: ['Athens', 'EUR'], IC: ['Iceland', 'ISK'], RG: ['Riga', 'EUR'], TL: ['Tallinn', 'EUR'], VS: ['Vilnius', 'EUR'],
  MU: ['Munich', 'EUR'], SG: ['Stuttgart', 'EUR'], BE: ['Berlin', 'EUR'], DU: ['Düsseldorf', 'EUR'], HM: ['Hamburg', 'EUR'],
  IL: ['London (international)', 'USD'], AQ: ['Aquis', 'GBp'], NE: ['Cboe Canada', 'CAD'], CN: ['Canadian Securities Exchange', 'CAD'],
};

// A list titled with a market ("Thai market SET50", "Nikkei 225", "Saudi Tadawul") means its
// bare tickers trade there: "DELTA" in a Thai list is DELTA.BK (Delta Electronics Thailand),
// not Delta Air Lines. Only markets outside the US are listed.
export const MARKETS = [
  [/\b(thai|thailand|set ?50|set ?100|bangkok)\b/i, 'BK'], [/\b(saudi|tadawul|tasi|riyadh)\b/i, 'SR'],
  [/\b(japan|japanese|nikkei|topix|tokyo)\b/i, 'T'], [/\b(korea|korean|kospi|krx|seoul)\b/i, 'KS'], [/\bkosdaq\b/i, 'KQ'],
  [/\b(hong kong|hang seng|hkex)\b/i, 'HK'], [/\b(india|indian|nifty|sensex|nse)\b/i, 'NS'],
  [/\b(brazil|brazilian|ibovespa|bovespa|b3)\b/i, 'SA'], [/\b(australia|australian|asx)\b/i, 'AX'],
  [/\b(ftse|london|uk|british)\b/i, 'L'], [/\b(dax|german|germany|xetra|mdax)\b/i, 'DE'], [/\b(cac|france|french|paris)\b/i, 'PA'],
  [/\b(tsx|canada|canadian|toronto)\b/i, 'TO'], [/\b(indonesia|indonesian|jakarta|idx)\b/i, 'JK'], [/\b(malaysia|malaysian|bursa|klci)\b/i, 'KL'],
  [/\b(singapore|sti|sgx)\b/i, 'SI'], [/\b(taiwan|taiwanese|taiex|twse)\b/i, 'TW'], [/\b(shanghai|csi ?300)\b/i, 'SS'], [/\bshenzhen\b/i, 'SZ'],
  [/\b(russia|russian|moex|imoex|moscow)\b/i, 'ME'], [/\b(swiss|switzerland|smi|zurich)\b/i, 'SW'], [/\b(spain|spanish|ibex|madrid)\b/i, 'MC'],
  [/\b(italy|italian|ftse mib|milan)\b/i, 'MI'], [/\b(dutch|netherlands|aex|amsterdam)\b/i, 'AS'], [/\b(south africa|jse|johannesburg)\b/i, 'JO'],
  [/\b(mexico|mexican|ipc)\b/i, 'MX'], [/\b(turkey|turkish|bist|istanbul)\b/i, 'IS'], [/\b(israel|israeli|tase|tel aviv)\b/i, 'TA'],
  [/\b(sweden|swedish|stockholm|omxs)\b/i, 'ST'], [/\b(norway|norwegian|oslo)\b/i, 'OL'], [/\b(denmark|danish|copenhagen)\b/i, 'CO'],
  [/\b(finland|finnish|helsinki)\b/i, 'HE'], [/\b(philippines|philippine|pse)\b/i, 'PS'], [/\b(new zealand|nzx)\b/i, 'NZ'],
  [/\b(qatar|qatari)\b/i, 'QA'], [/\b(dubai|uae|emirates)\b/i, 'AE'], [/\b(poland|polish|warsaw|wig)\b/i, 'WA'],
  [/\b(argentina|argentine|merval)\b/i, 'BA'], [/\b(chile|chilean|ipsa)\b/i, 'SN'], [/\b(egypt|egyptian|egx)\b/i, 'CA'],
];
export function marketSuffix(text) {
  for (const [re, sfx] of MARKETS) if (re.test(String(text || ''))) return sfx;
  return null;
}

// "OpenAI investors: MSFT, NVDA, 9984.T" names the list of picks.
// The title may contain commas ("Berkshire top 10 (13F, 30 Sep 2026)") but not ":", ";" or "|".
// A size after a ticker or name in a researched list: an index weight ("BHP.AX 9.8%") or a
// market value in US dollars ("BHP.AX 160bn", "BHP.AX $160bn", "SAP.DE 250b", "7203.T 0.3tn"). Without one,
// a share that is not listed in the US has no market value here and its tile gets a median size.
const SIZED = /^(.*?\S)\s*[=(:]?\s*(?:(\d+(?:\.\d+)?)\s*%|(?:US\$|USD\s*|\$)?(\d+(?:\.\d+)?)\s*(tn|trillion|t|bn|billion|b|mn|million|m)\b)\s*\)?\s*$/i;
const UNIT = { t: 1e12, tn: 1e12, trillion: 1e12, b: 1e9, bn: 1e9, billion: 1e9, m: 1e6, mn: 1e6, million: 1e6 };
// "000660.KS bn": the number was lost on the way (in double quotes the shell deletes "$22"):
// the share is kept, without a size, instead of turning into a question to research.
const LOST = /^(.*?\S)\s+\$?(?:tn|trillion|bn|billion|mn|million)\s*\)?\s*$/i;
export function sizeOf(raw) {
  const lost = LOST.exec(String(raw || ''));
  if (lost && !/\d/.test(lost[0].slice(lost[1].length))) return { text: lost[1], size: null, lost: true };
  const m = SIZED.exec(String(raw || ''));
  // Text with letters, or a numeric ticker ("9983", "005930"): not a bare number.
  if (!m || !(/[a-z]/i.test(m[1]) || /^\d{3,6}[A-Z]?$/.test(m[1].trim()))) return { text: raw, size: null };
  return { text: m[1], size: m[2] != null ? { indexWeight: +m[2] || 0.004 } : { cap: Math.round(+m[3] * UNIT[m[4].toLowerCase()]) } };
}

const TITLED = /^\s*([^:;|$]{2,60}?)\s*:\s*(\S.*)$/;
export const isTitledList = q => String(q || '').split(';').some(p => TITLED.test(p));

// Several named lists in one request, as the chat agent writes them after researching:
//   "OpenAI investors: MSFT, NVDA, 9984.T | private: Thrive Capital ; Nvidia suppliers: TSM, MU"
// Each list becomes its own section; the text after "|" is shown under it.
export function resolve(query, index, themes) {
  const parts = String(query || '').split(/\s*;\s*/).filter(Boolean);
  if (parts.length > 1 && parts.some(p => TITLED.test(p))) {
    const sections = [], unmatched = [];
    for (const p of parts) {
      const r = resolveOne(p, index, themes);
      for (const s of r.sections) if (!sections.some(x => x.id === s.id)) sections.push(s);
      unmatched.push(...r.unmatched);
    }
    return { sections, unmatched };
  }
  return resolveOne(query, index, themes);
}

function resolveOne(query, index, themes) {
  const { bySym } = lookupHelpers(index);
  const sections = [], picks = [], unmatched = [], seen = new Set();
  let picksTitle = 'Your picks', footnote = '';
  const titled = TITLED.exec(String(query || ''));
  if (titled) {
    picksTitle = titled[1];
    const bar = titled[2].indexOf('|');
    query = bar < 0 ? titled[2] : titled[2].slice(0, bar);
    footnote = bar < 0 ? '' : titled[2].slice(bar + 1).trim();
  }
  let given = null;   // the size the list gave for the share being read
  const addPick = (row, stock) => {
    const k = stock ? stock.y : row[SYM];
    if (seen.has(k)) return;
    seen.add(k);
    picks.push({ ...(stock || stockOf(row)), ...(given || {}) });
  };

  // The market in the title counts only when most bare tickers are not US ones: "Japan
  // exposure: AAPL, NKE" stays American, "Thai market SET50: ADVANC, AOT, DELTA" is Thai.
  let hint = titled ? marketSuffix(picksTitle) : null;
  if (hint) {
    const BARE = /^[A-Z0-9][A-Z0-9&-]{0,11}$/;
    const bare = splitQuery(query, true).map(p => sizeOf(p).text.trim()).filter(t => BARE.test(t));
    if (!bare.length || bare.filter(t => !bySym.has(t)).length * 2 < bare.length) hint = null;
  }
  for (const part of splitQuery(query, !!titled)) {
    let { text: raw, size } = titled ? sizeOf(part) : { text: part, size: null };
    // A bare ticker in a list titled with a market gets that market's suffix ("DELTA" → "DELTA.BK").
    if (hint && /^[A-Z0-9][A-Z0-9&-]{0,11}$/.test(raw.trim())) raw = raw.trim() + '.' + hint;
    given = size;
    const text = normalise(raw);
    const core = stripFiller(text);
    if (!core) continue;

    // 1. Ticker symbols: "$NVDA", "NVDA", or a run of them ("nvda amd tsla"). A symbol with
    //    a foreign exchange suffix ("9984.T") is taken as given; the price feed confirms it.
    const tokens = raw.replace(/\$/g, '').trim().split(/\s+/);
    if (tokens.length === 1 && (titled ? /^[A-Z0-9-]{1,10}\.[A-Z]{1,3}$/i : /^[A-Z0-9-]{2,10}\.[A-Z]{1,3}$/).test(tokens[0]) && !bySym.has(tokens[0].toUpperCase())) {
      const y = tokens[0].toUpperCase(), [t, sfx] = y.split('.'), ex = SUFFIX[sfx] || [sfx, ''];
      addPick(null, { y, t, n: y, x: ex[0], c: ex[1] });
      continue;
    }
    const tickerRows = tokens.map(t => bySym.get(t.toUpperCase()));
    const shouted = tokens.every(t => /^\$?[A-Z][A-Z0-9.\-]{0,5}$/.test(t));
    const themeHit = themeFor(core, themes) || themeFor(text, themes);
    const synHit = synonymList().find(s => s.re.test(core));
    const loneWord = tokens.length === 1 && (themeHit || synHit);
    if (tickerRows.every(Boolean) && ((shouted && !loneWord) || (!themeHit && !synHit && tokens.length > 1))) {
      tickerRows.forEach(r => addPick(r));
      continue;
    }
    // 2. A curated theme ("neoclouds", "ai", "magnificent 7").
    // In a researched list an upper-case "SPY" or "QQQ" is the fund itself, one share, not the
    // whole index its name stands for.
    if (themeHit && titled && tokens.length === 1 && /^[A-Z]{2,5}$/.test(tokens[0])) {
      addPick(null, { y: tokens[0], t: tokens[0], n: tokens[0], x: 'US', c: 'USD' });
      continue;
    }
    if (themeHit) {
      const sec = sectionFromTheme(themeHit.theme, bySym);
      if (!sections.some(s => s.id === sec.id)) sections.push(sec);
      continue;
    }
    // 3. A sector or industry word ("healthcare", "banks", "oil and gas").
    if (synHit) {
      const sec = sectionFromFilters(index, synHit.filters, synHit.title);
      if (sec) { sec.id = slug(synHit.title); if (!sections.some(s => s.id === sec.id)) sections.push(sec); continue; }
    }
    // 4. One ticker typed in lower case ("nvda").
    if (tickerRows.length === 1 && tickerRows[0]) { addPick(tickerRows[0]); continue; }
    // 5. A company name ("apple", "eli lilly").
    const byName = findByName(core, index);
    if (byName) { addPick(byName); continue; }
    const listed = findInThemes(core, themes);
    if (listed) { addPick(null, listed); continue; }
    // 6. Words that appear in an industry label ("railroads", "semiconductor equipment").
    const labels = industriesLike(core, index);
    if (labels.length) {
      const sec = sectionFromFilters(index, labels.map(l => 'I:^' + l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), raw.trim());
      if (sec) { sec.id = slug(raw); sections.push(sec); continue; }
    }
    unmatched.push(raw.trim());
  }
  // Restore the benchmark when reopening a previously saved, complete named index list.
  if (titled && !footnote && !unmatched.length && !sections.length) {
    const benchmark = themes.find(t => t.sizeBy === 'indexWeight' && t.title.toLowerCase() === picksTitle.toLowerCase());
    if (benchmark) {
      const members = benchmark.groups.flatMap(g => g.stocks);
      if (members.length === picks.length && members.every(s => seen.has(s[0]))) {
        return { sections: [sectionFromTheme(benchmark, bySym)], unmatched };
      }
    }
  }
  // Index weights given for most of the list size the tiles by weight; market values given
  // go where the US list's values go (stock.cap), so the page sizes by them anyway.
  const weighted = picks.filter(p => p.indexWeight > 0).length;
  if (picks.length) sections.unshift({ id: titled ? slug(picksTitle) : 'picks', title: picksTitle, blurb: weighted ? 'Tile size: index weight as given with the list.' : '', footnote, groups: [{ name: 'Selected shares', note: '', stocks: picks }], ...(weighted * 2 >= picks.length ? { sizeBy: 'indexWeight' } : {}) });
  return { sections, unmatched };
}

// What the page offers as one-click examples, and what the CLI lists when nothing matched.
export function vocabulary(themes) {
  return {
    themes: themes.map(t => ({ id: t.id, title: t.title, say: t.aliases[0] })),
    sectors: SYNONYMS.map(([phrases, title]) => ({ title, say: phrases[0] })),
  };
}

export function symbolsOf(sections) {
  const out = new Set();
  for (const s of sections) for (const g of s.groups) for (const st of g.stocks) out.add(st.y);
  return [...out];
}
