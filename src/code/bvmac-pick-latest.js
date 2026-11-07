// Africa brief · BVMAC: find the newest "Bulletin Officiel de la Cote" PDF linked on the BOC index page.
// The usual pattern is /wp-content/uploads/YYYY/MM/BOC-YYYYMMDD.pdf, but some files break it
// (e.g. BOC-20261026-1.pdf, or a March bulletin stored in the April folder), so we read the real links.
const page = $input.first().json;
if (page.error) {
  const msg = typeof page.error === 'string' ? page.error : page.error.message || 'request failed';
  return [{ json: { bocUrl: null, bocDate: null, error: `BOC index page: ${msg}` } }];
}
const html = String(page.bocIndexRaw || '');
const re = /(?:https?:\/\/(?:www\.)?bvm-ac\.org)?\/wp-content\/uploads\/\d{4}\/\d{2}\/BOC-(\d{8})(?:-(\d+))?\.pdf/gi;
const byDate = new Map(); // date -> { url, suffix }
let m;
while ((m = re.exec(html)) !== null) {
  const path = m[0].replace(/^https?:\/\/(?:www\.)?bvm-ac\.org/i, '');
  const url = `https://www.bvm-ac.org${path}`;
  const date = m[1];
  const suffix = m[2] ? Number(m[2]) : 0;
  const known = byDate.get(date);
  // WordPress adds "-1", "-2"… when a file is uploaded again, so the highest suffix is the latest upload.
  if (!known || suffix > known.suffix) byDate.set(date, { url, suffix });
}
if (byDate.size === 0) {
  return [{ json: { bocUrl: null, bocDate: null, error: 'No BOC PDF link found on the index page (layout may have changed)' } }];
}
const latest = [...byDate.keys()].sort().pop();
return [
  {
    json: {
      bocUrl: byDate.get(latest).url,
      bocDate: `${latest.slice(6, 8)}/${latest.slice(4, 6)}/${latest.slice(0, 4)}`,
      bulletinsListed: byDate.size,
    },
  },
];
