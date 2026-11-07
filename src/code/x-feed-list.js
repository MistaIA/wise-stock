// X (Twitter) posts without an account, through a Nitter mirror: one search per Config key ending in "XQuery"
// (ngxXQuery → market "ngx"), on one mirror of Config → xMirrors. The mirror that answered last time goes first;
// when it does not answer, the next run uses the next one in the list. Mirrors are run by volunteers: "Fetch X posts"
// asks one search a second, and only a few searches a run. xMirrors empty or "off" turns X posts off.
const cfg = $('Config').first().json;
const base = (m) => (/^https?:\/\//i.test(m) ? m : `https://${m}`).replace(/\/+$/, '');
const mirrors = String(cfg.xMirrors || '')
  .split(/[\s,;]+/)
  .filter((m) => m && !/^(off|none|no)$/i.test(m))
  .map(base);
const queries = Object.keys(cfg)
  .filter((k) => /XQuery$/.test(k) && String(cfg[k] || '').trim())
  .map((k) => ({ market: k.replace(/XQuery$/, ''), query: String(cfg[k]).trim() }));
if (!mirrors.length || !queries.length) {
  return [{ json: { url: '', off: true, why: mirrors.length ? 'no X search in Config' : 'X posts are off (Config → xMirrors is empty)' } }];
}
let last = null;
try {
  last = typeof $getWorkflowStaticData === 'function' ? $getWorkflowStaticData('global').xMirror : null;
} catch (e) {
  last = null;
}
const at = Math.max(0, mirrors.indexOf(last));
const mirror = mirrors[at];
const next = mirrors[(at + 1) % mirrors.length];
return queries.map((q) => ({ json: { ...q, mirror, next, url: `${mirror}/search/rss?f=tweets&q=${encodeURIComponent(q.query)}` } }));
