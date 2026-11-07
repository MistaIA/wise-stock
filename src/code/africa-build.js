// Africa brief · parse NGX (JSON), BRVM (HTML table) and BVMAC (BOC PDF text) into one clean summary, with each
// market's headlines and X posts, and one 🌙 share to look at per market.
// Every source is read inside try/catch: one broken website never blocks the whole brief.
// #include lib-feeds
const cfg = $('Config').first().json;
const TOP = Math.min(5, Math.max(1, Number(cfg.topMovers) || 3));
const nowMs = $now.toMillis();
const round2 = (x) => Math.round(x * 100) / 100;

const list = (s) =>
  String(s || '')
    .split(/[\s,;]+/)
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);
const num = (v, d = null) => {
  if (v === null || v === undefined || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
// French number: "31 995" → 31995, "-4,59" → -4.59. In JavaScript \s also matches non-breaking and narrow spaces.
const numFr = (s) => {
  if (s === null || s === undefined) return null;
  const t = String(s).replace(/\s/g, '').replace(/%$/, '').replace(',', '.');
  if (!/^[-+]?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
};
const errText = (j) =>
  typeof j.error === 'string' ? j.error : (j.error && (j.error.message || j.error.description)) || 'request failed';
const safeFirst = (name) => {
  try {
    return $(name).first().json || {};
  } catch (e) {
    return { error: `${name} did not run` };
  }
};

// The screen (🌙): business activity only, from the sector and the name or ticker (balance-sheet ratios are not
// available for these markets). It leaves out banks and other interest-based finance, insurers, alcohol, tobacco,
// gambling and hotels, plus the tickers in Config → screenExclude.
const FAIL_NAME =
  /\bbank|banque|\bboa\b|ecobank|coris|nsia|oragroup|soci[eé]t[eé] g[eé]n[eé]rale|\bsgb|\bsib\b|\bbici|\bbiic|assurance|insurance|r[eé]assurance|safca|leasing|loterie|lotter|\blotto\b|betting|casino|solibra|brasserie|brewer|guinness|distill|sitab|tabac|tobacco|h[oô]tel/i;
// The NGX feed names companies by their ticker only, so these are listed by ticker: brewers, hotels, and finance
// companies outside the "Financial services" sector. Shares on NGX's Non-Interest Finance Board pass.
const NGX_FAIL = new Set(['NB', 'INTBREW', 'CHAMPION', 'GOLDBREW', 'GUINNESS', 'IKEJAHOTEL', 'TRANSCOHOT', 'CUSTODIAN', 'VFDGROUP', 'CILEASING', 'NIDF']);
const EXCLUDE = new Set(list(cfg.screenExclude));
const ngxScreen = (r) =>
  !EXCLUDE.has(r.symbol) && (/non-interest/i.test(r.board) || !(NGX_FAIL.has(r.symbol) || /financial services/i.test(r.sector) || FAIL_NAME.test(r.name)));
const brvmScreen = (r) => !EXCLUDE.has(r.symbol) && !FAIL_NAME.test(r.name);

// Only shares that traded today count for breadth, movers and the pick.
const traded = (r) => r.changePct !== null && (r.volume === null || r.volume > 0);
function movers(rows) {
  const done = rows.filter(traded);
  const sorted = [...done].sort((a, b) => b.changePct - a.changePct);
  return {
    gainers: sorted.filter((r) => r.changePct > 0).slice(0, TOP),
    losers: sorted.filter((r) => r.changePct < 0).reverse().slice(0, TOP),
    advancers: done.filter((r) => r.changePct > 0).length,
    decliners: done.filter((r) => r.changePct < 0).length,
    unchanged: done.filter((r) => r.changePct === 0).length,
    notTraded: rows.length - done.length,
  };
}

// ---------- NGX (Nigeria) ----------
function parseNgx() {
  const j = safeFirst('NGX price list');
  if (j.error) throw new Error(errText(j));
  let body = j.ngxRaw;
  if (typeof body === 'string') body = JSON.parse(body);
  const rows = Array.isArray(body) ? body : (body && ((body.d && body.d.results) || body.value)) || [];
  const out = [];
  const seenSymbols = new Set(); // the feed can repeat a symbol: keep the first row
  for (const r of rows) {
    const symbol = String(r.Symbol || '').trim().toUpperCase();
    const close = num(r.ClosePrice);
    if (!symbol || close === null || close <= 0 || seenSymbols.has(symbol)) continue;
    seenSymbols.add(symbol);
    const prev = num(r.PrevClosingPrice);
    let changePct = num(r.PercChange); // already in percent (1.25 = +1.25 %); null happens in the real feed
    if (changePct === null && prev) changePct = (close / prev - 1) * 100;
    const volume = num(r.Volume, 0);
    out.push({
      symbol,
      name: String(r.Company2 || symbol).replace(/\s*\[[A-Z]+\]\s*$/, '').trim(), // "UBA [MRF]": NGX's flag after the name
      sector: String(r.Sector || '').trim(),
      board: String(r.Market || '').trim(),
      close,
      prev,
      changePct,
      volume,
      value: num(r.Value) ?? (volume > 0 ? volume * close : null), // naira traded
      tradeDate: String(r.TradeDate || '').slice(0, 10),
    });
  }
  if (out.length === 0) throw new Error('NGX feed returned no usable rows');
  const dates = {};
  out.forEach((r) => (dates[r.tradeDate] = (dates[r.tradeDate] || 0) + 1));
  const session = Object.entries(dates).sort((a, b) => b[1] - a[1])[0][0];
  out.forEach((r) => (r.screen = ngxScreen(r)));
  const wl = list(cfg.ngxWatchlist);
  return {
    session: session ? `${session.slice(8, 10)}/${session.slice(5, 7)}/${session.slice(0, 4)}` : 'n/a',
    count: out.length,
    watchlist: wl.map((s) => out.find((r) => r.symbol === s) || { symbol: s, missing: true }),
    dangote: out.filter((r) => /dangote/i.test(r.name) || /^DANG/.test(r.symbol)),
    ...movers(out),
    rows: out,
  };
}

// ---------- BRVM (West Africa / UEMOA) ----------
const HTML_NAMED = {
  lt: '<', gt: '>', laquo: '«', raquo: '»', agrave: 'à', acirc: 'â', ccedil: 'ç', eacute: 'é', egrave: 'è', ecirc: 'ê',
  euml: 'ë', icirc: 'î', iuml: 'ï', ocirc: 'ô', ugrave: 'ù', ucirc: 'û', uuml: 'ü', Agrave: 'À', Ccedil: 'Ç', Eacute: 'É',
  Egrave: 'È',
};
function decodeHtml(s) {
  return String(s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;|&rsquo;/gi, "'")
    .replace(/&([a-z]+);/gi, (m, n) => HTML_NAMED[n] ?? HTML_NAMED[n.toLowerCase()] ?? m)
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}
const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const FR_MONTHS = { janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12 };

function parseBrvm() {
  const j = safeFirst('BRVM price table');
  if (j.error) throw new Error(errText(j));
  const html = String(j.brvmRaw || '');
  // The page also has small "Top 5 / Flop 5" tables: take the table with a "Symbole" header and the most rows.
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  let best = null;
  for (const t of tables) {
    const headers = [...t.matchAll(/<th(?=[\s>])[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => fold(decodeHtml(m[1])));
    if (!headers.some((h) => h.startsWith('symbole'))) continue;
    const rows = [...t.matchAll(/<tr(?=[\s>])[^>]*>([\s\S]*?)<\/tr>/gi)]
      .filter((m) => /<td(?=[\s>])/i.test(m[1])) // skip the header row
      .map((m) => [...m[1].matchAll(/<t[dh](?=[\s>])[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => decodeHtml(c[1])))
      .filter((cells) => cells.length >= 5 && cells[0]);
    if (!best || rows.length > best.rows.length) best = { headers, rows };
  }
  if (!best || best.rows.length === 0) throw new Error('BRVM price table not found (page layout may have changed)');
  const h = best.headers;
  const col = (test, fallback) => {
    const i = h.findIndex(test);
    return i >= 0 ? i : fallback;
  };
  const iSym = col((x) => x.startsWith('symbole'), 0);
  const iName = col((x) => x.startsWith('nom'), 1);
  const iVol = col((x) => x.startsWith('volume'), 2);
  const iPrev = col((x) => x.includes('veille'), 3);
  const iClose = col((x) => x.includes('cloture'), 5);
  const iVar = col((x) => x.includes('variation'), 6);
  const out = best.rows
    .map((c) => ({
      symbol: String(c[iSym] || '').toUpperCase(),
      name: c[iName] || '',
      volume: numFr(c[iVol]),
      prev: numFr(c[iPrev]),
      close: numFr(c[iClose]),
      changePct: numFr(c[iVar]),
    }))
    .filter((r) => /^[A-Z]{2,6}$/.test(r.symbol) && r.close !== null);
  if (out.length === 0) throw new Error('BRVM price table has no readable rows');
  out.forEach((r) => {
    r.value = r.volume === null ? null : r.volume * r.close; // FCFA traded
    r.screen = brvmScreen(r);
  });
  let session = 'n/a';
  const upd = decodeHtml(html).match(/Derni[eè]re mise [àa] jour\s*:\s*[A-Za-zéû]+,?\s*(\d{1,2})\s+([A-Za-zéèûô]+),?\s+(\d{4})/i);
  if (upd) {
    const month = FR_MONTHS[fold(upd[2])];
    if (month) session = `${upd[1].padStart(2, '0')}/${String(month).padStart(2, '0')}/${upd[3]}`;
  }
  const wl = list(cfg.brvmWatchlist);
  return {
    session,
    count: out.length,
    watchlist: wl.map((s) => out.find((r) => r.symbol === s) || { symbol: s, missing: true }),
    ...movers(out),
    rows: out,
  };
}

// ---------- BVMAC (Central Africa / CEMAC) ----------
const BVMAC_KNOWN = {
  CM0000010009: { ticker: 'SEMC', name: 'SEMC (mineral water)', screen: true, key: /SEM\s?C/i },
  CM0000010017: { ticker: 'SAFACAM', name: 'SAFACAM (rubber & palm oil)', screen: true, key: /SAF/i },
  CM0000010025: { ticker: 'SOCAPALM', name: 'SOCAPALM (palm oil)', screen: true, key: /SOCAP/i },
  CM0000010041: { ticker: 'LA REGIONALE', name: 'La Régionale (savings & credit)', screen: false, key: /REG/i },
  GQ0000010050: { ticker: 'BANGE', name: 'BANGE (bank)', screen: false, key: /BANGE/i },
  GA0000010066: { ticker: 'SCG-RE', name: 'SCG-Ré (reinsurance)', screen: false, key: /SCG/i },
  GA0000010074: { ticker: 'BGFI HC', name: 'BGFI Holding (bank)', screen: false, key: /BHC|BGFI/i },
};
// BVMAC share ISINs follow the 00000100NN series; bonds use other series and are ignored.
const EQUITY_ISIN = /^[A-Z]{2}00000100\d{2}$/;

// All ways to read the last `count` numbers of a run like "52 50052 50057 75047 250": numbers use spaces as
// thousands separators and may be glued together (n8n's PDF reader joins text on the same line without spaces).
// relaxed = also accept plain digit runs, for PDFs whose thousands separator was lost.
function lastNumbers(str, count, relaxed = false) {
  const results = [];
  const NUM = relaxed ? /^(0|[1-9]\d{0,6})$/ : /^(0|[1-9]\d{0,2}(?: \d{3})*)$/;
  function walk(end, need, acc) {
    if (results.length >= 5000) return;
    if (need === 0) {
      results.push(acc);
      return;
    }
    let e = end;
    while (e > 0 && str[e - 1] === ' ') e--;
    for (let s = e - 1; s >= Math.max(0, e - 15); s--) {
      const cand = str.slice(s, e);
      if (!NUM.test(cand)) continue;
      const value = Number(cand.replace(/ /g, ''));
      if (s > 0 && !/[\d ]/.test(str[s - 1])) {
        if (need === 1) walk(s, 0, [value, ...acc]);
        continue;
      }
      walk(s, need - 1, [value, ...acc]);
    }
  }
  walk(str.length, count, []);
  return results;
}

// Find "opening, close, upper limit, lower limit, change %" in one share's row. The BVMAC daily limits are
// reference price ±10 %, so (upper + lower) / 2 is the reference and close / reference must give the printed change:
// that check picks the one correct reading among all the ways glued numbers can be split.
function parseBocRow(windowText) {
  const t = windowText.replace(/\s+/g, ' ');
  for (const relaxed of [false, true]) {
    for (let k = t.indexOf('%'); k !== -1; k = t.indexOf('%', k + 1)) {
      let best = null;
      let s = k;
      while (s > 0 && /[\d ,\-]/.test(t[s - 1])) s--;
      const run = t.slice(s, k).replace(/\s+$/, '');
      for (const L of [1, 2]) {
        const m = run.match(new RegExp(`(-?)(\\d{${L}},\\d{2})$`));
        if (!m) continue;
        if (L === 2 && m[2][0] === '0') continue;
        const change = numFr(m[1] + m[2]);
        const rest = run.slice(0, run.length - m[0].length);
        for (const [open, close, hi, lo] of lastNumbers(rest, 4, relaxed)) {
          if (!(hi > lo && lo > 0)) continue;
          const ref = (hi + lo) / 2;
          const band = (hi - lo) / (hi + lo);
          if (band < 0.03 || band > 0.21) continue;
          if (close < lo - 1 || close > hi + 1) continue;
          if (open !== 0 && (open < lo - 1 || open > hi + 1)) continue;
          const err = Math.abs((close / ref - 1) * 100 - change);
          if (err > 0.06) continue;
          if (!best || err < best.err) best = { open, close, upperLimit: hi, lowerLimit: lo, ref, changePct: change, err };
        }
      }
      if (best) return best;
    }
  }
  return null;
}

function parseBvmac() {
  const pick = safeFirst('Pick latest BOC');
  if (pick.error) throw new Error(errText(pick));
  const pdf = safeFirst('Read BOC text');
  if (pdf.error) throw new Error(`BOC PDF: ${errText(pdf)}`);
  const text = String(pdf.text || '').replace(/[^\S\n]/g, ' '); // every kind of space → ' ', keep line breaks
  if (text.length < 200) throw new Error('BOC PDF text is empty (scanned PDF?)');

  let index = null;
  const cover = text.match(/ALL\s*SHARE\s*INDEX\s*([0-9][0-9 ]*,\d{2})\s*(-?\d{1,2},\d{2})\s*%/i);
  if (cover) index = { value: numFr(cover[1]), changePct: numFr(cover[2]) };
  const comment = text.match(/passant de\s*([0-9][0-9 ]*,\d{2})\s*(?:points\s*)?[àa]\s*([0-9][0-9 ]*,\d{2})\s*points/i);
  if (comment) {
    const prev = numFr(comment[1]);
    const cur = numFr(comment[2]);
    if (!index && prev && cur) index = { value: cur, changePct: Math.round((cur / prev - 1) * 10000) / 100 };
  }
  const head = text.match(/COTE\s*N\s*[°º]?\s*(\d{3,5})\s*DU\s*(\d{2}\/\d{2}\/\d{4})/i);

  const isinRe = /(CM|GA|GQ|CF|TD|CG)\s?(\d{10})(?!\d)/g;
  const hits = [];
  let m;
  while ((m = isinRe.exec(text)) !== null) hits.push({ isin: m[1] + m[2], pos: m.index, len: m[0].length });
  const equities = [];
  const seen = new Set();
  hits.forEach((hit, i) => {
    if (seen.has(hit.isin)) return;
    const known = BVMAC_KNOWN[hit.isin];
    if (!known && !EQUITY_ISIN.test(hit.isin)) return;
    const start = hit.pos + hit.len;
    const end = i + 1 < hits.length ? Math.min(hits[i + 1].pos, start + 900) : start + 900;
    const windowText = text.slice(start, end);
    // Guard against a column-wise PDF layout: the share's short name must follow its ISIN,
    // otherwise the numbers in this window may belong to another share.
    if (known && !known.key.test(windowText.slice(0, 80))) return;
    const row = parseBocRow(windowText);
    if (!row) return;
    seen.add(hit.isin);
    const info = known || { ticker: hit.isin, name: `new share ${hit.isin}`, screen: null };
    const screen = info.screen === true && EXCLUDE.has(info.ticker) ? false : info.screen;
    equities.push({ isin: hit.isin, ticker: info.ticker, name: info.name, screen, close: row.close, ref: row.ref, changePct: row.changePct, isNew: !known });
  });
  const missing = Object.keys(BVMAC_KNOWN)
    .filter((isin) => !seen.has(isin))
    .map((isin) => BVMAC_KNOWN[isin].ticker);
  return {
    bulletin: head ? `n°${head[1]} du ${head[2]}` : `du ${pick.bocDate}`,
    session: head ? head[2] : pick.bocDate,
    url: pick.bocUrl,
    index,
    equities,
    unparsed: missing,
  };
}


const sources = {};
const errors = {};
for (const [key, fn] of [
  ['ngx', parseNgx],
  ['brvm', parseBrvm],
  ['bvmac', parseBvmac],
]) {
  try {
    sources[key] = fn();
  } catch (e) {
    errors[key] = String(e.message || e).slice(0, 200);
  }
}

// ---------- closing prices of the last sessions, for the 5-session trend ----------
// Kept in the workflow's static data, which n8n saves after every run except a manual test run in the editor.
const KEEP_SESSIONS = 10;
const isoDay = (dmy) => (/^\d{2}\/\d{2}\/\d{4}$/.test(dmy || '') ? `${dmy.slice(6, 10)}-${dmy.slice(3, 5)}-${dmy.slice(0, 2)}` : null);
const sd = FEEDS.staticData();
const history = sd && sd.history && typeof sd.history === 'object' ? JSON.parse(JSON.stringify(sd.history)) : {};
function remember(market, day, rows) {
  const past = (Array.isArray(history[market]) ? history[market] : []).filter((s) => s && typeof s.d === 'string' && s.c && typeof s.c === 'object');
  if (!day || !rows.length || (past.length && past[past.length - 1].d > day)) return past; // an older session than the newest kept
  const closes = {};
  rows.forEach((r) => {
    if (r.screen === true && r.close > 0) closes[r.symbol] = r.close;
  });
  history[market] = past.filter((s) => s.d !== day).concat([{ d: day, c: closes }]).slice(-KEEP_SESSIONS);
  return history[market];
}
// Change from the close up to 5 sessions back to today's close; needs at least 3 sessions.
function trendOf(sessions, symbol, close) {
  const series = sessions.map((s) => s.c[symbol]).filter((v) => typeof v === 'number' && v > 0).slice(-6);
  return series.length >= 3 ? { pct: (close / series[0] - 1) * 100, sessions: series.length - 1 } : null;
}

// ---------- one 🌙 share to look at per market ----------
// Among the 🌙 shares that traded, did not fall today and traded at least the median value of the 🌙 shares that
// traded: the best of today's change (40 %) and the 5-session trend (60 %), or today's change alone without history.
function pickOf(rows, sessions) {
  const done = rows.filter((r) => r.screen === true && traded(r));
  const values = done.map((r) => r.value).filter((v) => typeof v === 'number' && v > 0).sort((a, b) => a - b);
  const median = values.length ? values[Math.floor((values.length - 1) / 2)] : null;
  const best = done
    .filter((r) => r.changePct >= 0 && (median === null || (r.value || 0) >= median))
    .map((r) => {
      const t = trendOf(sessions, r.symbol, r.close);
      return { r, t, score: t ? 0.6 * t.pct + 0.4 * r.changePct : r.changePct };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || (b.r.value || 0) - (a.r.value || 0))[0];
  if (!best) return null;
  const { r, t } = best;
  return { symbol: r.symbol, name: r.name, close: r.close, changePct: round2(r.changePct), trendPct: t ? round2(t.pct) : null, trendSessions: t ? t.sessions : null, value: r.value ?? null, score: round2(best.score) };
}

const picks = { ngx: null, brvm: null, bvmac: null };
const marketRows = {
  ngx: sources.ngx ? sources.ngx.rows : [],
  brvm: sources.brvm ? sources.brvm.rows : [],
  bvmac: sources.bvmac ? sources.bvmac.equities.map((e) => ({ ...e, symbol: e.ticker, volume: null, value: null })) : [],
};
for (const m of ['ngx', 'brvm', 'bvmac']) {
  if (!sources[m]) continue;
  const sessions = remember(m, isoDay(sources[m].session), marketRows[m]);
  picks[m] = pickOf(marketRows[m], sessions);
}
if (sd) sd.history = history;
if (sources.ngx) delete sources.ngx.rows;
if (sources.brvm) delete sources.brvm.rows;

// ---------- headlines (Google News) and X posts (Nitter) per market ----------
const hours = { news: Math.max(1, Number(cfg.newsHours) || 72), x: Math.max(1, Number(cfg.xHours) || 24) };
const feeds = { ngx: { news: [], posts: [] }, brvm: { news: [], posts: [] }, bvmac: { news: [], posts: [] } };
let asked = [];
try {
  asked = $('Headline feeds').all().map((i) => i.json);
} catch (e) {
  asked = [];
}
let fetched = [];
try {
  fetched = $('Fetch headlines').all().map((i) => i.json);
} catch (e) {
  fetched = [];
}
asked.forEach((q, i) => {
  const f = feeds[q.market];
  if (!f) return;
  const r = fetched[i] || { error: 'no answer' };
  const items = r.error ? null : FEEDS.parse(r.feedRaw);
  if (items) f.news = FEEDS.headlines(items, { now: nowMs, hours: hours.news, max: 5 });
  else f.newsError = r.error ? FEEDS.errorText(r.error) : 'Google News did not send a feed';
});
const xRead = FEEDS.readX({ now: nowMs, hours: hours.x, max: 10 });
for (const [m, v] of Object.entries(xRead.markets)) {
  if (!feeds[m]) continue;
  feeds[m].posts = v.posts;
  if (v.error) feeds[m].postsError = v.error;
}
const x = { state: xRead.state, mirror: xRead.mirror || null, next: xRead.next || null, error: xRead.error || null, why: xRead.why || null };
// Ids for the AI's rating: h1, h2… for headlines, x1, x2… for posts.
let nh = 0;
let nx = 0;
for (const m of ['ngx', 'brvm', 'bvmac']) {
  feeds[m].news.forEach((a) => (a.id = `h${++nh}`));
  feeds[m].posts.forEach((p) => (p.id = `x${++nx}`));
}

const asOf = $now.setZone('Africa/Lagos').toFormat('ccc d LLL yyyy');
const brief = (r) => ({ s: r.symbol, n: r.name, c: r.close, ch: r.changePct === null ? null : round2(r.changePct) });
const pickFacts = (p) => p && { s: p.symbol, c: p.close, ch: p.changePct, trendPct: p.trendPct, trendSessions: p.trendSessions, valueTraded: p.value };
const market = (x, p) =>
  x && {
    session: x.session,
    breadth: { up: x.advancers, down: x.decliners, unchanged: x.unchanged, notTraded: x.notTraded },
    watchlist: x.watchlist.filter((r) => !r.missing).map(brief),
    gainers: x.gainers.map(brief),
    losers: x.losers.map(brief),
    pick: pickFacts(p),
  };
const aiFacts = {
  date: asOf,
  ngx: market(sources.ngx, picks.ngx),
  brvm: market(sources.brvm, picks.brvm),
  bvmac: sources.bvmac && {
    session: sources.bvmac.session,
    index: sources.bvmac.index,
    equities: sources.bvmac.equities.map((e) => ({ s: e.ticker, c: e.close, ch: e.changePct })),
    pick: pickFacts(picks.bvmac),
  },
  headlines: ['ngx', 'brvm', 'bvmac'].flatMap((m) => feeds[m].news.map((a) => ({ id: a.id, market: m, title: a.title, source: a.source, hoursAgo: Math.round((nowMs - a.ts) / 360000) / 10 }))),
  posts: ['ngx', 'brvm', 'bvmac'].flatMap((m) => feeds[m].posts.map((p) => ({ id: p.id, market: m, text: p.text }))),
  failedSources: Object.keys(errors),
};

return [{ json: { asOf, ...sources, errors, picks, feeds, x, hours, aiFacts: JSON.stringify(aiFacts) } }];
