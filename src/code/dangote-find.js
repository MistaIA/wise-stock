// Dangote watch · keep only what is new: recent IPO headlines and any Dangote company newly listed on NGX, with what
// X (Twitter) says, read through a Nitter mirror. "New" means published within Config → lookbackHours: no database
// (the workflow only remembers which X mirror answered last).
// #include lib-feeds
const cfg = $('Config').first().json;
const source = cfg.source || 'schedule';
const lookbackHours = Number(source === 'schedule' ? cfg.lookbackHours : cfg.lookbackHoursOnDemand) || 12;
const known = String(cfg.knownDangoteSymbols || '')
  .split(/[\s,;]+/)
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const now = $now.toMillis();

// ---- News (Google News RSS) ----
let articles = [];
let newsError = null;
try {
  const items = $('Google News RSS').all().map((i) => i.json);
  if (items.length === 1 && items[0].error) throw new Error(FEEDS.errorText(items[0].error));
  const asRss = items.map((a) => ({ title: a && a.title, link: a && a.link, source: '', ts: Date.parse((a && (a.isoDate || a.pubDate)) || '') }));
  articles = FEEDS.headlines(asRss, { now, hours: lookbackHours, max: 8 });
} catch (e) {
  newsError = String(e.message || e).slice(0, 200);
}

// ---- X posts (Nitter mirror) ----
const xRead = FEEDS.readX({ now, hours: lookbackHours, max: 10 });
const posts = Object.values(xRead.markets).flatMap((v) => v.posts);
const x = { state: xRead.state, mirror: xRead.mirror || null, next: xRead.next || null, error: xRead.error || null, why: xRead.why || null };
articles.forEach((a, i) => (a.id = `h${i + 1}`));
posts.forEach((p, i) => (p.id = `x${i + 1}`));

// ---- NGX: Dangote companies, and any Dangote symbol we have not seen before (e.g. the refinery listing) ----
let shares = [];
let newListings = [];
let ngxError = null;
let session = null;
try {
  const j = $('NGX price list').first().json;
  if (j.error) throw new Error(FEEDS.errorText(j.error));
  let body = j.ngxRaw;
  if (typeof body === 'string') body = JSON.parse(body);
  const rows = Array.isArray(body) ? body : (body && ((body.d && body.d.results) || body.value)) || [];
  const isDangote = (r) => /dangote/i.test(String(r.Company2 || '')) || /^DANG/i.test(String(r.Symbol || '')) || known.includes(String(r.Symbol || '').trim().toUpperCase());
  shares = rows.filter(isDangote).map((r) => {
    const close = Number(r.ClosePrice);
    const prev = Number(r.PrevClosingPrice);
    let changePct = r.PercChange === null || r.PercChange === undefined || r.PercChange === '' ? null : Number(r.PercChange);
    if (changePct === null && prev > 0) changePct = (close / prev - 1) * 100;
    return { symbol: String(r.Symbol).trim().toUpperCase(), name: String(r.Company2 || r.Symbol).trim(), close, changePct, tradeDate: String(r.TradeDate || '').slice(0, 10) };
  });
  newListings = shares.filter((s) => !known.includes(s.symbol));
  session = shares.length ? shares[0].tradeDate : null;
} catch (e) {
  ngxError = String(e.message || e).slice(0, 200);
}

const hasNews = articles.length > 0;
const hasListing = newListings.length > 0;
// X posts about Dangote come every hour, so on the schedule only headlines or a new listing are worth a message.
const shouldReport = hasNews || hasListing || source !== 'schedule';

const aiFacts = JSON.stringify({
  headlines: articles.map((a) => ({ id: a.id, title: a.title, source: a.source, hoursAgo: Math.round((now - a.ts) / 360000) / 10 })),
  posts: posts.map((p) => ({ id: p.id, text: p.text })),
  newNgxListings: newListings.map((s) => s.symbol),
  ipoContext: cfg.ipoNote,
});

return [{ json: { source, lookbackHours, articles, posts, x, shares, newListings, session, newsError, ngxError, hasNews, hasListing, shouldReport, aiFacts } }];
