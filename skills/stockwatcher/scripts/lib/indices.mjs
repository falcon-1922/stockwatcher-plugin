// Market indices (S&P 500, Nasdaq-100, Dow 30) as themes: every member, grouped by GICS
// sector, biggest first - the classic market heat map. Members ship in data/indices.json
// (refresh with scripts/build-indices.mjs).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const INDEX_DEFS = [
  { key: 'sp500', id: 'sp500', title: 'S&P 500', blurb: 'All members of the S&P 500, grouped by sector; block size is market value.',
    aliases: ['s&p 500', 's&p500', 's&p', 'sp500', 'sp 500', 'sp index', 'snp 500', 'spx', 'spy', 'standard and poors', 'standard & poors', 'the market', 'stock market', 'us market', 'whole market', 'overall market', 'market heatmap', 'market heat map'] },
  { key: 'ndx', id: 'ndx', title: 'Nasdaq-100', blurb: 'The 100 largest non-financial companies on the Nasdaq exchange, grouped by sector.',
    aliases: ['nasdaq 100', 'nasdaq-100', 'nasdaq100', 'ndx', 'qqq', 'nasdaq'] },
  { key: 'dow', id: 'dow', title: 'Dow Jones', blurb: 'The 30 companies in the Dow Jones Industrial Average, grouped by sector.',
    aliases: ['dow jones', 'dow 30', 'dow', 'djia', 'dow jones industrial average', 'dia'] },
];

export function indexThemes(indices) {
  return INDEX_DEFS.filter(d => indices && Array.isArray(indices[d.key]) && indices[d.key].length).map(d => ({
    id: d.id, title: d.title, aliases: d.aliases, blurb: d.blurb, groups: [],
    members: indices[d.key].map(r => [r[0], r[2] || '']),        // [symbol, sector]
  }));
}

// Index themes first, so "s&p 500" is never mistaken for anything else.
export function loadThemes(dataDir) {
  const curated = JSON.parse(readFileSync(join(dataDir, 'themes.json'), 'utf8'));
  let indices = null;
  try { indices = JSON.parse(readFileSync(join(dataDir, 'indices.json'), 'utf8')); } catch { /* optional */ }
  return [...indexThemes(indices), ...curated];
}

// Nasdaq's sector labels → GICS sector names, for index members the S&P list does not cover.
export const TO_GICS = {
  Technology: 'Information Technology', 'Health Care': 'Health Care', Finance: 'Financials',
  'Consumer Discretionary': 'Consumer Discretionary', 'Consumer Staples': 'Consumer Staples',
  Industrials: 'Industrials', Energy: 'Energy', Utilities: 'Utilities', 'Real Estate': 'Real Estate',
  'Basic Materials': 'Materials', Telecommunications: 'Communication Services', Miscellaneous: 'Industrials',
};
