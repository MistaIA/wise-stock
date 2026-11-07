#!/usr/bin/env node
// Tests tools/check-sources.mjs against the local stand-in of the outside services (tests/e2e/mock-server.mjs),
// with the libraries of a real n8n install:
//   N8N_PACKAGE=/path/to/node_modules/n8n node tests/check-sources.test.mjs
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock } from './e2e/mock-server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = join(ROOT, 'tools', 'check-sources.mjs');
const N8N = process.env.N8N_PACKAGE || '/home/claude/n8n-test/node_modules/n8n';

function run(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [TOOL, ...args], { timeout: 120000, env: { ...process.env, LOCALAPPDATA: '' } }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: stdout, err: stderr }),
    );
  });
}
const line = (out, label) => out.split('\n').find((l) => l.startsWith(label.padEnd(11))) || '';
const RELIGIOUS = /halal|haram|shari'?a|islam|muslim|aaoifi|charia|☪/i;

const { server } = await startMock(0);
const M = `http://127.0.0.1:${server.address().port}`;
const maps = (over = {}) =>
  Object.entries({
    'https://doclib.ngxgroup.com/REST/api/statistics/equities/': `${M}/ngx`,
    'https://www.brvm.org/fr/cours-actions/0': `${M}/brvm`,
    'https://www.bvm-ac.org/bulletin-officiel-de-la-cote-boc/': `${M}/boc-index`,
    'https://www.bvm-ac.org/wp-content/': `${M}/wp-content/`,
    'https://news.google.com/rss/search?q=': `${M}/rss?q=`,
    'https://nitter.kareem.one': `${M}/nitter`,
    ...over,
  }).flatMap(([from, to]) => ['--map', `${from}=${to}`]);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const tmp = mkdtempSync(join(tmpdir(), 'check-sources-'));

test('all sources answer: every market is read with the workflows\' code, both briefs are printed, files saved', async () => {
  const save = join(tmp, 'ok');
  const r = await run(['--n8n', N8N, ...maps(), '--save', save]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(line(r.out, 'NGX'), /^NGX +ok +13 shares, session 06\/11\/2026, watchlist 6\/6$/);
  assert.match(line(r.out, 'BRVM'), /^BRVM +ok +\d+ shares, séance \d\d\/\d\d\/\d{4}, watchlist \d\/\d/);
  assert.match(line(r.out, 'BVMAC'), /^BVMAC +ok +BOC n°2632 du 05\/11\/2026: 7 shares, All Share Index 1123\.84 \(\+2\.18%\)$/);
  assert.match(line(r.out, 'Headlines'), /^Headlines +ok +Google News: NGX 3, BRVM 2, BVMAC 1 from the last 72 h$/);
  assert.match(line(r.out, 'X posts'), /^X posts +ok +nitter\.kareem\.one: NGX 2, BRVM 1, BVMAC 0 posts from the last 24 h$/);
  assert.match(line(r.out, 'News'), /^News +ok +Google News "Dangote refinery IPO": 3 items, 3 from the last 72 h$/);
  assert.match(line(r.out, 'Dangote'), /^Dangote +ok +DANGCEM ₦540, DANGSUGAR ₦48\.5, NASCON ₦72 \(session 2026-11-06\)$/);
  assert.match(line(r.out, 'X Dangote'), /^X Dangote +ok +nitter\.kareem\.one: 2 posts from the last 72 h$/);
  assert.match(r.out, /---- SM-02 Africa brief[^\n]*----\n🌍 Africa markets brief · /);
  assert.match(r.out, /BVMAC \(CEMAC\) · BOC n°2632 du 05\/11\/2026/);
  assert.match(r.out, /🌙 To look at: MTNN · ₦420\.00 \(\+5\.00%\) · ₦126\.0m traded/);
  assert.match(r.out, /🌙 To look at: SNTS · /);
  // Keywords: "rise/gains" good, "drop … profit" neither, "cheer … dividend" good; posts: "climbs" good, "drops" bad.
  assert.match(r.out, /🧭 Mood: 🟢 positive · 3 good, 1 bad, 1 neutral\n🟢 Dangote Cement shares rise as NGX gains 1% · BusinessDay · 3 h ago/);
  assert.match(r.out, /𝕏 2 posts in 24 h, latest:\n🟢 @naijastocks: NGX All-Share index climbs/);
  assert.match(r.out, /𝕏 On X \(last 72 h\): 2 posts, latest:\n🟢 @oilwatcher: Dangote refinery IPO demand surges, shares to list in December · 1 h ago/);
  assert.doesNotMatch(r.out, RELIGIOUS);
  assert.match(r.out, /---- SM-03 Dangote watch[^\n]*----\n🛢️ Dangote watch · /);
  assert.match(r.out, /Dangote Petroleum Refinery shares to list on NGX in December/);
  assert.doesNotMatch(r.out, /<b>|&amp;|&lt;/, 'the briefs are shown as plain text');
  assert.match(r.out, /All sources answered and were read\./);
  for (const f of ['ngx-equities.json', 'brvm-cours-actions.html', 'boc-index.html', 'BOC-20261105.pdf', 'boc.txt', 'news-ngx.xml', 'news-brvm.xml', 'news-bvmac.xml', 'x-ngx.xml', 'x-brvm.xml', 'x-bvmac.xml', 'google-news.xml', 'sm03-x-dangote.xml', 'sm02-build-africa-brief.json', 'sm03-find-what-is-new.json', 'check-sources.txt']) {
    assert.ok(existsSync(join(save, f)), `${f} saved`);
  }
  assert.equal(readFileSync(join(save, 'ngx-equities.json'), 'utf8'), readFileSync(join(ROOT, 'tests', 'fixtures', 'ngx-equities.json'), 'utf8'));
  assert.match(readFileSync(join(save, 'boc.txt'), 'utf8'), /BVMAC ALL SHARE INDEX/);
  const saved = readFileSync(join(save, 'check-sources.txt'), 'utf8');
  assert.match(saved, /^Live check of the market sources/);
  assert.ok(saved.includes(line(r.out, 'BVMAC')) && saved.includes('All sources answered and were read.'), 'check-sources.txt holds what was printed');
  // The requests carried the headers of the workflows' HTTP nodes.
});

test('the requests use the URL and headers of the workflow nodes', async () => {
  const { server: s2, log } = await startMock(0);
  const M2 = `http://127.0.0.1:${s2.address().port}`;
  const r = await run(['--n8n', N8N, ...maps({
    'https://doclib.ngxgroup.com/REST/api/statistics/equities/': `${M2}/ngx`,
    'https://www.brvm.org/fr/cours-actions/0': `${M2}/brvm`,
    'https://news.google.com/rss/search?q=': `${M2}/rss?q=`,
  })]);
  s2.close();
  assert.equal(r.code, 0, r.out + r.err);
  const ngx = log.filter((x) => x.path === '/ngx');
  assert.equal(ngx.length, 2, 'SM-02 and SM-03 each fetch the NGX list');
  for (const x of ngx) {
    assert.equal(x.headers.accept, 'application/json;odata=verbose');
    assert.match(x.headers['user-agent'], /^StockMarketBrief\/1\.0/);
    assert.deepEqual(x.query, { market: '', sector: '', orderby: '', pageSize: '400', pageNo: '0' });
  }
  const brvm = log.find((x) => x.path === '/brvm');
  assert.equal(brvm.headers['accept-language'], 'fr');
  const rss = log.find((x) => x.path === '/rss' && /Dangote/.test(x.query.q));
  assert.deepEqual(rss.query, { q: 'Dangote refinery IPO', hl: 'en-NG', gl: 'NG', ceid: 'NG:en' });
  assert.equal(rss.headers['user-agent'], 'rss-parser');
  assert.match(rss.headers.accept, /^application\/rss\+xml, application\/rdf\+xml;q=0\.8/);
  // SM-02's headlines: one search per market, in its language, with the workflow's own User-Agent.
  const news = log.filter((x) => x.path === '/rss' && !/Dangote/.test(x.query.q));
  assert.deepEqual(news.map((x) => [x.query.q, x.query.hl, x.query.gl]), [['"Nigerian Exchange" OR NGX OR "Nigerian stocks"', 'en-NG', 'NG'], ['BRVM', 'fr', 'CI'], ['BVMAC', 'fr', 'CM']]);
  for (const x of news) assert.match(x.headers['user-agent'], /^StockMarketBrief\/1\.0/);
});

test('X posts: one search a second on the mirror, with an honest User-Agent and an RSS Accept header', async () => {
  const { server: s3, log } = await startMock(0);
  const M3 = `http://127.0.0.1:${s3.address().port}`;
  const r = await run(['--n8n', N8N, ...maps({ 'https://nitter.kareem.one': `${M3}/nitter` })]);
  s3.close();
  assert.equal(r.code, 0, r.out + r.err);
  const x = log.filter((l) => l.path === '/nitter/search/rss');
  assert.deepEqual(x.map((l) => l.query.q), ['NGX OR NGXASI OR "Nigerian stocks"', 'BRVM', 'BVMAC', '"Dangote refinery" OR "Dangote IPO"']);
  assert.ok(x.every((l) => l.query.f === 'tweets'));
  for (let i = 1; i < 3; i++) assert.ok(x[i].at - x[i - 1].at >= 1000, `SM-02 searches ${i} and ${i + 1} are ${x[i].at - x[i - 1].at} ms apart`);
  for (const l of x) {
    assert.match(l.headers['user-agent'], /^StockMarketBrief\/1\.0 \(n8n; personal market digest\)$/);
    assert.match(l.headers.accept, /^application\/rss\+xml/);
  }
});

test('a mirror that is down or sends a bot check: X is named, the market data is fine, exit code 1', async () => {
  let r = await run(['--n8n', N8N, '--fast', ...maps({ 'https://nitter.kareem.one': `${M}/nitter-down` })]);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(line(r.out, 'X posts'), /^X posts +FAILED +no answer from nitter\.kareem\.one: 503 Service Unavailable - mirror busy; the brief goes out without X posts$/);
  assert.match(line(r.out, 'X Dangote'), /^X Dangote +FAILED +no answer from nitter\.kareem\.one: 503 /);
  assert.match(line(r.out, 'NGX'), / ok /);
  assert.match(line(r.out, 'Headlines'), / ok /);
  assert.match(r.out, /X posts: no answer from nitter\.kareem\.one \(503 Service Unavailable - mirror busy\)/, 'the brief names it too');
  assert.doesNotMatch(r.out, /𝕏/);
  assert.match(r.out, /Problem with: X posts, X Dangote\. The market data is fine; the briefs go out without X posts until a mirror answers\. X posts come from Nitter mirrors/);
  r = await run(['--n8n', N8N, '--fast', ...maps({ 'https://nitter.kareem.one': `${M}/nitter-botcheck` })]);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(line(r.out, 'X posts'), /FAILED +no answer from nitter\.kareem\.one: it sent a web page instead of a feed \(busy, or a bot check\)/);
});

test('retries like n8n: a source that answers on the third try is read', async () => {
  const { server: s4, log } = await startMock(0);
  const M4 = `http://127.0.0.1:${s4.address().port}`;
  const r = await run(['--n8n', N8N, '--fast', ...maps({ 'https://doclib.ngxgroup.com/REST/api/statistics/equities/': `${M4}/flaky/ngx` })]);
  s4.close();
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(line(r.out, 'NGX'), /^NGX +ok +13 shares/);
  assert.match(line(r.out, 'Dangote'), / ok /);
  assert.equal(log.filter((l) => l.path === '/flaky/ngx').length, 4, 'SM-02: 503, 503, then the list; SM-03: the list');
});

test('a site that fails is named, the others are still read, exit code 1', async () => {
  const r = await run(['--n8n', N8N, '--fast', ...maps({ 'https://www.brvm.org/fr/cours-actions/0': `${M}/gone` })]);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(line(r.out, 'BRVM'), /^BRVM +FAILED +404 Not Found - mock: no route for \/gone \(tried 3 times\)$/);
  assert.match(line(r.out, 'NGX'), / ok /);
  assert.match(line(r.out, 'BVMAC'), / ok /);
  assert.match(r.out, /Source problems today/, 'the brief says which source failed, as the real one would');
  assert.match(r.out, /Problem with: BRVM\./);
});

test('NGX unreachable: both the Africa brief and the Dangote watch report it', async () => {
  const closed = await new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
  const r = await run(['--n8n', N8N, '--fast', ...maps({ 'https://doclib.ngxgroup.com/REST/api/statistics/equities/': `http://127.0.0.1:${closed}/ngx` })]);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(line(r.out, 'NGX'), /^NGX +FAILED +fetch failed \(ECONNREFUSED\) \(tried 3 times\)$/);
  assert.match(line(r.out, 'Dangote'), /^Dangote +FAILED +NGX: fetch failed \(ECONNREFUSED\) \(tried 3 times\)$/);
  assert.match(line(r.out, 'News'), / ok /);
});

test('a BOC that is not a PDF, and an index page without bulletins', async () => {
  let r = await run(['--n8n', N8N, '--fast', ...maps({ 'https://www.bvm-ac.org/wp-content/': `${M}/brvm?` })]);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(line(r.out, 'BVMAC'), /^BVMAC +FAILED +BOC PDF: PDF could not be read: /);
  r = await run(['--n8n', N8N, ...maps({ 'https://www.bvm-ac.org/bulletin-officiel-de-la-cote-boc/': `${M}/brvm` })]);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(line(r.out, 'BVMAC'), /^BVMAC +FAILED +No BOC PDF link found on the index page/);
});

test('usage errors and n8n not found: exit code 2', async () => {
  for (const args of [['--map', 'nonsense'], ['--map'], ['--frobnicate'], ['--n8n', join(tmp, 'nothing-here')]]) {
    const r = await run(args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.out}${r.err}`);
    assert.match(r.err, /^check-sources: /);
  }
  const h = await run(['--help']);
  assert.equal(h.code, 0);
  assert.match(h.out, /Exit codes: 0 every source answered/);
  assert.doesNotMatch(h.out, /^\/\/|#!/m);
});

let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`ok   ${t.name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${t.name}\n     ${String(e.message).split('\n').join('\n     ')}`);
  }
}
server.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
