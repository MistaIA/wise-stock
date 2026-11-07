// Africa brief · build the Telegram message (HTML parse mode), with or without the AI part.
// #include lib-compose
const d = $('Build Africa brief').first().json;
const { json: ai, text: aiText } = TG.aiAnswer('AI insights');
const rated = ai && ai.sentiment && typeof ai.sentiment === 'object' && !Array.isArray(ai.sentiment) ? ai.sentiment : {};
const byAi = Object.keys(rated).length > 0;
const why = ai && ai.why && typeof ai.why === 'object' ? ai.why : {};
let insights = ai ? (Array.isArray(ai.insights) ? ai.insights : typeof ai.insights === 'string' ? ai.insights.split('\n') : []) : [];
insights = insights
  .map((t) => String(t).replace(/^\s*[•*-]\s*/, '').trim())
  .filter(Boolean)
  .slice(0, 5);

const { esc, link } = TG;
const now = $now.toMillis();
const ch = (x) => (x === null || x === undefined ? '' : ` (${x > 0 ? '+' : ''}${Number(x).toFixed(2)}%)`);
const naira = (x) => (x === null || x === undefined ? 'n/a' : `₦${Number(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const fcfa = (x) => (x === null || x === undefined ? 'n/a' : `${Number(x).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} FCFA`);
const compact = (x) => (x >= 1e9 ? `${(x / 1e9).toFixed(1)}bn` : x >= 1e6 ? `${(x / 1e6).toFixed(1)}m` : x >= 1e3 ? `${Math.round(x / 1e3)}k` : String(Math.round(x)));
const MONEY = { ngx: naira, brvm: fcfa, bvmac: fcfa };
const traded = { ngx: (v) => `₦${compact(v)} traded`, brvm: (v) => `${compact(v)} FCFA traded`, bvmac: () => '' };
const moon = (s) => (s === true ? ' 🌙' : '');
const arrow = (x) => (x > 0 ? '🟢' : x < 0 ? '🔴' : '⚪');
const rate = (item) => (item.id in rated ? TG.rating(rated[item.id]) : item.kw || 0);
const feeds = d.feeds || {};
const hours = d.hours || { news: 72, x: 24 };

// The 🌙 share to look at, and why (from the AI, when it answered).
function pickLines(m) {
  const p = (d.picks || {})[m];
  if (!p) return [`🌙 <b>To look at:</b> <i>none today (no 🌙 share is rising${m === 'bvmac' ? '' : ' on good volume'})</i>`];
  const bits = [`${MONEY[m](p.close)}${ch(p.changePct)}`];
  if (p.trendPct !== null && p.trendPct !== undefined) bits.push(`${p.trendPct > 0 ? '+' : ''}${p.trendPct.toFixed(1)}% over ${p.trendSessions} sessions`);
  if (p.value) bits.push(traded[m](p.value));
  const lines = [`🌙 <b>To look at: ${esc(p.symbol)}</b> · ${bits.filter(Boolean).join(' · ')}`];
  if (typeof why[m] === 'string' && why[m].trim()) lines.push(`<i>${esc(TG.short(why[m].trim(), 300))}</i>`);
  return lines;
}

// Mood, headlines and X posts of one market.
function feedLines(m) {
  const f = feeds[m] || {};
  const news = f.news || [];
  const posts = d.x && d.x.state === 'ok' ? f.posts || [] : [];
  const lines = [];
  const mood = TG.mood([...news, ...posts].map(rate));
  if (mood) lines.push(`🧭 <b>Mood:</b> ${mood.label} · ${mood.good} good, ${mood.bad} bad, ${mood.neutral} neutral`);
  news.slice(0, 3).forEach((a) => lines.push(`${TG.dot(rate(a))} ${link(a.link, esc(a.title))}${a.source ? ` · ${esc(a.source)}` : ''} · ${TG.ago(a.ts, now)}`));
  if (!news.length && !f.newsError) lines.push(`📰 <i>No headlines in the last ${hours.news} h.</i>`);
  if (d.x && d.x.state === 'ok') {
    if (posts.length) {
      lines.push(`𝕏 <b>${posts.length} post${posts.length === 1 ? '' : 's'}</b> in ${hours.x} h, latest:`);
      posts.slice(0, 2).forEach((p) => lines.push(`${TG.dot(rate(p))} ${link(p.link, `@${esc(p.user)}`)}: ${esc(TG.short(p.text, 160))}`));
    } else if (!f.postsError) lines.push(`𝕏 <i>No posts in the last ${hours.x} h.</i>`);
  }
  return lines;
}

function marketBlock(title, m, money, key) {
  const b = [title];
  b.push(`Breadth: ${m.advancers}▲ ${m.decliners}▼ ${m.unchanged}＝${m.notTraded ? ` · ${m.notTraded} not traded` : ''} (${m.count} listed)`);
  const wl = m.watchlist.filter((r) => !r.missing);
  if (wl.length) {
    b.push('<b>Watchlist</b>');
    wl.forEach((r) => b.push(`${arrow(r.changePct)} ${esc(r.symbol)} ${money(r.close)}${ch(r.changePct)}${moon(r.screen)}`));
  }
  const miss = m.watchlist.filter((r) => r.missing).map((r) => r.symbol);
  if (miss.length) b.push(`<i>Not in today's list: ${esc(miss.join(', '))}</i>`);
  if (m.gainers.length) b.push(`<b>Top gainers:</b> ${m.gainers.map((r) => `${esc(r.symbol)}${ch(r.changePct)}${moon(r.screen)}`).join(' · ')}`);
  if (m.losers.length) b.push(`<b>Top losers:</b> ${m.losers.map((r) => `${esc(r.symbol)}${ch(r.changePct)}${moon(r.screen)}`).join(' · ')}`);
  return [...b, ...pickLines(key), ...feedLines(key)].join('\n');
}
// A market whose prices did not come today still shows its headlines and posts.
const feedsOnly = (title, key) => {
  const lines = feedLines(key);
  return lines.length ? [title, ...lines].join('\n') : null;
};

const blocks = [`🌍 <b>Africa markets brief</b> · ${esc(d.asOf)}`];
if (d.ngx) blocks.push(marketBlock(`🇳🇬 <b>NGX Nigeria</b> · session ${esc(d.ngx.session)}`, d.ngx, naira, 'ngx'));
else blocks.push(feedsOnly('🇳🇬 <b>NGX Nigeria</b> · <i>no prices today</i>', 'ngx'));
if (d.brvm) blocks.push(marketBlock(`🌍 <b>BRVM (UEMOA)</b> · séance ${esc(d.brvm.session)}`, d.brvm, fcfa, 'brvm'));
else blocks.push(feedsOnly('🌍 <b>BRVM (UEMOA)</b> · <i>no prices today</i>', 'brvm'));
if (d.bvmac) {
  const v = d.bvmac;
  const b = [`🌍 <b>BVMAC (CEMAC)</b> · BOC ${esc(v.bulletin)}`];
  if (v.index) b.push(`BVMAC All Share Index <b>${Number(v.index.value).toLocaleString('fr-FR', { minimumFractionDigits: 2 })}</b>${ch(v.index.changePct)}`);
  v.equities.forEach((e) => b.push(`${arrow(e.changePct)} ${esc(e.ticker)} ${fcfa(e.close)}${ch(e.changePct)}${moon(e.screen)}${e.isNew ? ' 🆕 new on BVMAC' : ''}`));
  if (v.unparsed.length) b.push(`<i>Could not read: ${esc(v.unparsed.join(', '))}. See the bulletin.</i>`);
  if (v.url) b.push(link(v.url, 'Open the official bulletin (PDF)'));
  blocks.push([...b, ...pickLines('bvmac'), ...feedLines('bvmac')].join('\n'));
} else blocks.push(feedsOnly('🌍 <b>BVMAC (CEMAC)</b> · <i>no bulletin today</i>', 'bvmac'));

if (insights.length) blocks.push(`🧠 <b>Insights</b>\n${insights.map((t) => `• ${esc(t)}`).join('\n')}`);
else if (!ai && aiText && !TG.looksLikeJson(aiText)) blocks.push(`🧠 <b>Insights</b>\n${esc(aiText)}`);

const problems = Object.entries(d.errors || {}).map(([k, v]) => `${k.toUpperCase()}: ${esc(v)}`);
for (const m of ['ngx', 'brvm', 'bvmac']) if (feeds[m] && feeds[m].newsError) problems.push(`Headlines ${m.toUpperCase()}: ${esc(feeds[m].newsError)}`);
if (d.x && d.x.state === 'failed') problems.push(`X posts: no answer from ${esc(d.x.mirror)} (${esc(d.x.error)})${d.x.next ? `; the next run tries ${esc(d.x.next)}` : ''}`);
if (problems.length) blocks.push(`⚠️ <b>Source problems today</b>\n${problems.join('\n')}`);

const anyFeed = ['ngx', 'brvm', 'bvmac'].some((m) => feeds[m] && ((feeds[m].news || []).length || (feeds[m].posts || []).length));
blocks.push(
  `<i>🌙 passes the screen (business activity only; debt not checked).${anyFeed ? ` Mood and dots: headlines and X posts rated ${byAi ? 'by the AI' : 'by keywords (no AI rating today)'}.` : ''} Information only, not financial advice.</i>`,
);

const messages = TG.split(blocks.filter(Boolean));
const data = { ...d, ai: ai ? { insights, sentiment: rated, why } : null };
return messages.map((text, i) => ({ json: { text, part: i + 1, parts: messages.length, data: i === 0 ? data : undefined } }));
