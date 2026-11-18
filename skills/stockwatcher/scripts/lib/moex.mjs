// The Moscow Exchange's own public data (ISS, iss.moex.com; no key, no account):
// - prices for Moscow listings (Yahoo symbols ending in ".ME"). Yahoo stopped updating them in
//   2022 and still answers with those old numbers, so they come from the exchange instead;
// - the members and weights of the MOEX Russia index (IMOEX), refreshed while the server runs;
// - market values of Moscow shares in US dollars (Bank of Russia rate), so a researched list
//   of Moscow tickers is sized without anyone looking the sizes up.
const ISS = 'https://iss.moex.com/iss';
const DAY = 86400;

export const isMoex = s => /\.ME$/i.test(String(s || ''));
const secid = s => String(s).replace(/\.ME$/i, '').toUpperCase();

// English names and sectors for the index members: the exchange publishes neither in a usable
// form (its Latin names read "Tatneft-3", "IPJSC TCS Holding"). A new member missing here is
// shown with the exchange's Latin name under "Other".
export const MOEX_INFO = {
  LKOH: ['Lukoil', 'Oil and gas'], ROSN: ['Rosneft', 'Oil and gas'], GAZP: ['Gazprom', 'Oil and gas'],
  NVTK: ['Novatek', 'Oil and gas'], TATN: ['Tatneft', 'Oil and gas'], TATNP: ['Tatneft (pref.)', 'Oil and gas'],
  SNGS: ['Surgutneftegas', 'Oil and gas'], SNGSP: ['Surgutneftegas (pref.)', 'Oil and gas'], TRNFP: ['Transneft (pref.)', 'Oil and gas'],
  SBER: ['Sberbank', 'Financials'], SBERP: ['Sberbank (pref.)', 'Financials'], T: ['T-Technologies', 'Financials'],
  VTBR: ['VTB Bank', 'Financials'], MOEX: ['Moscow Exchange', 'Financials'], CBOM: ['Credit Bank of Moscow', 'Financials'],
  SVCB: ['Sovcombank', 'Financials'], BSPB: ['Bank Saint Petersburg', 'Financials'], DOMRF: ['DOM.RF', 'Financials'],
  RENI: ['Renaissance Insurance', 'Financials'], AFKS: ['AFK Sistema', 'Financials'],
  GMKN: ['Norilsk Nickel', 'Metals and mining'], PLZL: ['Polyus', 'Metals and mining'], CHMF: ['Severstal', 'Metals and mining'],
  NLMK: ['NLMK', 'Metals and mining'], MAGN: ['MMK', 'Metals and mining'], RUAL: ['Rusal', 'Metals and mining'],
  ALRS: ['Alrosa', 'Metals and mining'], UGLD: ['Yuzhuralzoloto (UGC)', 'Metals and mining'], ENPG: ['En+ Group', 'Metals and mining'],
  PHOR: ['PhosAgro', 'Chemicals'],
  YDEX: ['Yandex', 'Technology and internet'], OZON: ['Ozon', 'Technology and internet'], HEAD: ['HeadHunter', 'Technology and internet'],
  POSI: ['Positive Technologies', 'Technology and internet'], VKCO: ['VK', 'Technology and internet'], CNRU: ['Cian', 'Technology and internet'],
  MTSS: ['MTS', 'Telecoms'], RTKM: ['Rostelecom', 'Telecoms'],
  X5: ['X5 Group', 'Consumer'], MGNT: ['Magnit', 'Consumer'], RAGR: ['Rusagro', 'Consumer'], MDMG: ['MD Medical Group', 'Consumer'],
  IRAO: ['Inter RAO', 'Utilities'], AFLT: ['Aeroflot', 'Transport'], FLOT: ['Sovcomflot', 'Transport'],
};

const getJson = async (fetchImpl, url, ms = 15000) => {
  const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(ms) });
  if (!res.ok) { const e = new Error('moex ' + res.status); e.status = res.status; throw e; }
  return res.json();
};
const ymd = t => new Date(t).toISOString().slice(0, 10);

// ISS tables come as { columns: [...], data: [[...], ...] }.
export function table(json, name) {
  const t = json && json[name];
  if (!t || !Array.isArray(t.columns) || !Array.isArray(t.data)) return [];
  return t.data.map(r => Object.fromEntries(t.columns.map((c, i) => [c, r[i]])));
}

// Daily candles → the { timestamp, close } shape the other feeds give. The last candle is
// today's, so its close is the latest trade while the market is open.
export function readCandles(json) {
  const timestamp = [], close = [];
  for (const r of table(json, 'candles')) {
    const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(r.begin || '');
    if (!m || r.close == null || !isFinite(r.close)) continue;
    timestamp.push(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 1000);
    close.push(+r.close);
  }
  return { timestamp, close };
}

// A year of daily closes for one Moscow listing. Without a board the exchange uses the
// share's main one (TQBR for ordinary shares). One page holds 500 candles, more than a year.
export async function moexHistory(symbol, fetchImpl = fetch, now = Date.now()) {
  const url = ISS + '/engines/stock/markets/shares/securities/' + encodeURIComponent(secid(symbol))
    + '/candles.json?iss.meta=off&interval=24&candles.columns=begin,close&from=' + ymd(now - 372 * DAY * 1000);
  return readCandles(await getJson(fetchImpl, url));
}

export function readIndex(json) {
  const rows = table(json, 'analytics').filter(r => r.ticker && r.weight > 0);
  return { date: rows.length ? rows[0].tradedate : null, rows: rows.map(r => [r.ticker, +r.weight, r.shortnames || r.ticker]) };
}

// The index as a dashboard theme: members grouped by sector, biggest sector first, tile area
// = index weight. Stocks are [symbol, ticker, name, exchange, currency, weight]. Sectors under
// 2% of the index share one group: alone, a box that small is shorter than its own label and
// its tiles do not show at all.
const SMALL_SECTOR = 2;
export function indexGroups(rows, latin = {}) {
  const bySector = new Map();
  for (const [t, w, short] of [...rows].sort((a, b) => b[1] - a[1])) {
    const [name, sector] = MOEX_INFO[t] || [latin[t] || short || t, 'Other sectors'];
    if (!bySector.has(sector)) bySector.set(sector, []);
    bySector.get(sector).push([t + '.ME', t, name, 'Moscow', 'RUB', w]);
  }
  const total = g => g.reduce((a, s) => a + s[5], 0);
  const big = [], small = [], smallNames = [];
  for (const [name, stocks] of bySector) {
    if (total(stocks) >= SMALL_SECTOR && name !== 'Other sectors') big.push([name, stocks]);
    else { small.push(...stocks); if (name !== 'Other sectors') smallNames.push(name.toLowerCase()); }
  }
  const groups = big.sort((a, b) => total(b[1]) - total(a[1]))
    .map(([name, stocks]) => ({ name, note: total(stocks).toFixed(1) + '% of the index', stocks }));
  if (small.length) groups.push({ name: 'Other sectors', note: total(small).toFixed(1) + '% of the index' + (smallNames.length ? ': ' + smallNames.join(', ') : ''), stocks: small.sort((a, b) => b[5] - a[5]) });
  return groups;
}

export const blurbFor = date => 'Tile area shows MOEX Russia index weight' + (date ? ' on ' + longDate(date) : '')
  + ', as published by the Moscow Exchange. Prices in roubles from the exchange. Point at a tile for its weight.';
function longDate(d) {
  const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(d);
  return m ? +m[3] + ' ' + ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][+m[2] - 1] + ' ' + m[1] : d;
}

// The Bank of Russia's official rate: roubles per US dollar. The exchange itself stopped
// trading dollars in 2024, so it has no dollar rate of its own.
export function readCbrUsd(xml) {
  const m = /<CharCode>USD<\/CharCode>\s*<Nominal>(\d+)<\/Nominal>[\s\S]*?<Value>([\d,.]+)<\/Value>/.exec(String(xml || ''));
  if (!m) return null;
  const v = parseFloat(m[2].replace(',', '.')) / +m[1];
  return v > 0 ? v : null;
}

// What the server keeps: the index theme up to date, market values for sizing, and nothing
// on disk (all of it is one or two requests away).
export function createMoex({ fetchImpl = fetch, log = () => {}, indexMs = 6 * 3600_000, capsMs = 3600_000 } = {}) {
  let caps = null, capsAt = 0, capsLoading = null;
  const state = { indexAt: 0 };

  async function loadCaps() {
    const [md, xml] = await Promise.all([
      getJson(fetchImpl, ISS + '/engines/stock/markets/shares/boards/TQBR/securities.json?iss.meta=off&iss.only=marketdata&marketdata.columns=SECID,ISSUECAPITALIZATION'),
      fetchImpl('https://www.cbr.ru/scripts/XML_daily.asp', { signal: AbortSignal.timeout(15000) }).then(r => (r.ok ? r.text() : ''), () => ''),
    ]);
    const rub = readCbrUsd(xml);
    if (!rub) throw new Error('no rouble rate from the Bank of Russia');
    const out = new Map();
    for (const r of table(md, 'marketdata')) if (r.ISSUECAPITALIZATION > 0) out.set(r.SECID + '.ME', Math.round(r.ISSUECAPITALIZATION / rub));
    log('moex: market values for ' + out.size + ' shares (' + rub.toFixed(2) + ' RUB per USD)');
    return out;
  }
  function capsSoon() {
    if (!capsLoading && Date.now() - capsAt > capsMs) {
      capsLoading = loadCaps().then(m => { caps = m; capsAt = Date.now(); }, e => { log('moex market values failed: ' + e.message); capsAt = Date.now() - capsMs + 60_000; })
        .finally(() => { capsLoading = null; });
    }
    return capsLoading || Promise.resolve();
  }

  // Gives Moscow shares that came without a size (a researched list, a ticker typed by hand)
  // their market value, waiting at most budgetMs for the first download.
  async function enrich(sections, budgetMs = 1500) {
    const bare = [];
    for (const s of sections) {
      if (s.sizeBy) continue;   // index weight, holdings or volume already size these
      for (const g of s.groups) for (const st of g.stocks) if (isMoex(st.y) && !(st.cap > 0)) bare.push(st);
    }
    if (!bare.length) return 0;
    await Promise.race([capsSoon(), new Promise(r => { const t = setTimeout(r, budgetMs); if (t.unref) t.unref(); })]);
    let n = 0;
    if (caps) for (const st of bare) { const c = caps.get(st.y.toUpperCase()); if (c) { st.cap = c; n++; } }
    return n;
  }

  // Keeps the shipped index theme (data/themes.json) in line with today's weights.
  async function refreshIndex(theme) {
    const [idx, sec] = await Promise.all([
      getJson(fetchImpl, ISS + '/statistics/engines/stock/markets/index/analytics/IMOEX.json?iss.meta=off&limit=100'),
      getJson(fetchImpl, ISS + '/engines/stock/markets/shares/boards/TQBR/securities.json?iss.meta=off&iss.only=securities&securities.columns=SECID,LATNAME').catch(() => null),
    ]);
    const { date, rows } = readIndex(idx);
    if (rows.length < 10) throw new Error('only ' + rows.length + ' index members came back');
    const latin = Object.fromEntries(table(sec, 'securities').map(r => [r.SECID, r.LATNAME]));
    theme.groups = indexGroups(rows, latin);
    theme.blurb = blurbFor(date);
    state.indexAt = Date.now();
    log('moex: MOEX Russia index, ' + rows.length + ' members, weights of ' + date);
  }
  function keepIndexFresh(theme) {
    if (!theme) return () => {};
    const run = () => refreshIndex(theme).catch(e => log('moex index refresh failed (keeping the shipped weights): ' + e.message));
    run();
    const t = setInterval(run, indexMs);
    if (t.unref) t.unref();
    return () => clearInterval(t);
  }

  return { enrich, refreshIndex, keepIndexFresh, state };
}
