// Africa brief · one Google News search per market (Config → ngxNewsQuery, brvmNewsQuery, bvmacNewsQuery), in the
// language the market's press writes in. "Fetch headlines" downloads them; "Build Africa brief" reads them.
const cfg = $('Config').first().json;
const SEARCHES = [
  ['ngx', 'ngxNewsQuery', 'NGX', 'hl=en-NG&gl=NG&ceid=NG:en'],
  ['brvm', 'brvmNewsQuery', 'BRVM', 'hl=fr&gl=CI&ceid=CI:fr'],
  ['bvmac', 'bvmacNewsQuery', 'BVMAC', 'hl=fr&gl=CM&ceid=CM:fr'],
];
return SEARCHES.map(([market, key, fallback, locale]) => {
  const query = String(cfg[key] || '').trim() || fallback;
  return { json: { market, query, url: `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&${locale}` } };
});
