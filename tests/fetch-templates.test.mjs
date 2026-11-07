#!/usr/bin/env node
// Tests for templates/fetch-templates.mjs against a local server shaped like the awesome-n8n-templates site
// (pages = the template README rendered inside the site layout) and like raw.githubusercontent.com (README + JSON).
// Runs the real defuddle CLI: DEFUDDLE_CLI=<path to defuddle/dist/cli.js>, or the script installs defuddle with npm
// into a temporary folder first (needs registry.npmjs.org).
//   node tests/fetch-templates.test.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fetcher = await import(join(ROOT, 'templates', 'fetch-templates.mjs'));
const work = mkdtempSync(join(tmpdir(), 'sm-fetch-test-'));

// ---------------- fixtures: 3 templates in the site's README format ----------------
const T = {
  '111-send-a-telegram-stock-brief': { title: '📈 Send a Telegram stock brief', nodes: 'HTTP Request, Telegram', views: '9,000' },
  '222-crypto-price-bot-telegram': { title: '📈 Crypto \\| price bot (Telegram)', nodes: 'Telegram Trigger', views: '5,000' },
  '333-weekly-sheets-report': { title: '📈 Weekly Sheets report', nodes: 'Google Sheets', views: '1,000' },
};
const categoryReadme = `# 📈 Crypto Trading & Stock Market

> **3 templates** — test fixtures.

[⬅️ Back to main index](../../README.md)

## 📋 Templates

| Template | Description | 🔗 Key Nodes | 👀 Views |
|----------|-------------|:-------------|-------:|
${Object.entries(T).map(([slug, t], i) => `| [${i === 0 ? '🏆 ' : ''}${t.title.replace('📈 ', '')}](${slug}/) | A test template. | ${t.nodes} | ${t.views} |`).join('\n')}
`;
const templateReadme = (t) => `# ${t.title}

> ⚡ **${t.views} views** · 📈 [Crypto Trading & Stock Market](../)

## Description

This workflow is a test fixture.

## 🔗 Nodes Used

${t.nodes}

## 📥 Import

Download [\`workflow.json\`](workflow.json) and import into n8n:
`;
const KEY = 'AbCdEfGhIjKlMnOpQrStUvWx12';
const workflows = {
  '111-send-a-telegram-stock-brief': { name: 'brief', nodes: [{ name: 'HTTP', parameters: { url: 'https://example.com/q?symbol={{ $json.s }}&apikey={{ $json.key }}' } }], connections: {} },
  '222-crypto-price-bot-telegram': {
    name: 'bot',
    nodes: [
      { name: 'Quote', parameters: { url: `https://financialmodelingprep.com/stable/quote?symbol=BTC&apikey=${KEY}`, queryParameters: { parameters: [{ name: 'apikey', value: `=${KEY}` }, { name: 'limit', value: '250' }] } } },
      { name: 'AI', parameters: { headerParameters: { parameters: [{ name: 'Authorization', value: `Bearer sk-proj-${KEY}${KEY}` }] } } },
      { name: 'Bot', parameters: { text: `token 123456789:AA${KEY}${KEY}` } },
    ],
    connections: {},
  },
  '333-weekly-sheets-report': { name: 'report', nodes: [], connections: {} },
};

// ---------------- a server shaped like the site (Astro build) and like raw GitHub ----------------
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
function html(md) {
  const out = [];
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('|') && /^\|[-:| ]+\|$/.test(lines[i + 1] || '')) {
      const cells = (r) => r.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
      out.push('<table><thead><tr>' + cells(l).map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>');
      for (i += 2; i < lines.length && lines[i].startsWith('|'); i++) out.push('<tr>' + cells(lines[i]).map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>');
      out.push('</tbody></table>');
      continue;
    }
    const h = /^(#{1,3}) (.*)/.exec(l);
    if (h) out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
    else if (l.startsWith('> ')) out.push(`<blockquote><p>${inline(l.slice(2))}</p></blockquote>`);
    else if (l.trim()) out.push(`<p>${inline(l)}</p>`);
  }
  return out.join('\n');
}
const page = (title, body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} | Awesome n8n Templates</title><meta name="author" content="ScraperNode"></head>` +
  `<body><nav><a href="/site/">Awesome n8n Templates</a> <a href="/site/templates/">Categories</a></nav><main class="content"><article>${body}</article></main>` +
  `<footer class="footer"><p>Built by ScraperNode. MIT Licensed.</p></footer></body></html>`;

const hits = [];
const behaviour = { drop: new Map(), status: new Map() }; // path → connections to drop / HTTP status to answer
const server = createServer((q, s) => {
  hits.push(q.url);
  const left = behaviour.drop.get(q.url) || 0;
  if (left > 0) {
    behaviour.drop.set(q.url, left - 1);
    s.destroy(); // a dropped connection, as on a bad line
    return;
  }
  if (behaviour.status.has(q.url)) {
    s.writeHead(behaviour.status.get(q.url), { 'content-type': 'text/html' });
    return s.end(page('Error', '<h1>Error</h1><p>Something went wrong on this page.</p>'));
  }
  let m;
  if (q.url === '/site/templates/crypto-trading/') {
    s.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return s.end(page('📈 Crypto Trading & Stock Market', html(categoryReadme)));
  }
  if ((m = /^\/site\/templates\/crypto-trading\/([a-z0-9-]+)\/$/.exec(q.url)) && T[m[1]]) {
    s.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return s.end(page(T[m[1]].title, html(templateReadme(T[m[1]]))));
  }
  if (q.url === '/raw/templates/crypto-trading/README.md') {
    s.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return s.end(categoryReadme);
  }
  if ((m = /^\/raw\/templates\/crypto-trading\/([a-z0-9-]+)\/workflow\.json$/.exec(q.url)) && workflows[m[1]]) {
    s.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return s.end(JSON.stringify(workflows[m[1]]));
  }
  s.writeHead(404, { 'content-type': 'text/html' });
  s.end(page('Not found', '<h1>404</h1><p>There is no page here.</p>'));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const tools = join(work, 'tools');
const common = ['--site', `${base}/site/`, '--raw', `${base}/raw/`, '--delays', '0,0,0', ...(process.env.DEFUDDLE_CLI ? ['--defuddle', process.env.DEFUDDLE_CLI] : ['--tools', tools])];
const fetchRun = async (out, ...args) => {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    return { code: await fetcher.main([...common, '--out', join(work, out), ...args]), text: lines.join('\n') };
  } finally {
    console.log = orig;
  }
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('arguments: the 7 project templates by default; bad ids and folder names refused', async () => {
  assert.deepEqual(fetcher.parseArgs([]).ids, fetcher.DEFAULT_IDS);
  assert.equal(fetcher.DEFAULT_IDS.length, 7);
  assert.throws(() => fetcher.parseArgs(['--ids', '12,abc']), /template numbers/);
  assert.throws(() => fetcher.parseArgs(['--category', '../x']), /folder name/);
  assert.throws(() => fetcher.parseArgs(['--ids']), /needs a value/);
  assert.equal(fetcher.parseArgs(['--all']).ids, null);
  assert.equal(fetcher.parseArgs(['--site', 'http://x']).site, 'http://x/');
});

test('template links: defuddle output (absolute URLs) and the GitHub README (relative), titles cleaned', async () => {
  const fromSite = fetcher.templateLinks('| [🏆 Stock \\| bot (Telegram)](https://x.io/awesome/templates/crypto-trading/42-stock-bot/) | a |\n| [B](https://x.io/awesome/templates/crypto-trading/43-b/) |\n[again](https://x.io/awesome/templates/crypto-trading/42-stock-bot/)', 'crypto-trading');
  assert.deepEqual(fromSite, [{ id: '42', slug: '42-stock-bot', title: 'Stock | bot (Telegram)' }, { id: '43', slug: '43-b', title: 'B' }]);
  const fromReadme = fetcher.templateLinks(categoryReadme, 'crypto-trading');
  assert.deepEqual(fromReadme.map((t) => t.slug), Object.keys(T));
  assert.equal(fromReadme[1].title, 'Crypto | price bot (Telegram)');
  assert.deepEqual(fetcher.templateLinks('[x](https://x.io/templates/ai-tools/44-other/)', 'crypto-trading'), [], 'other categories are ignored');
});

test('keys left in a template become placeholders; n8n expressions and placeholders stay', async () => {
  const { raw, found } = fetcher.redactKeys(JSON.stringify(workflows['222-crypto-price-bot-telegram'], null, 2));
  assert.ok(!raw.includes(KEY), raw);
  assert.match(raw, /apikey=YOUR_API_KEY/);
  assert.match(raw, /"value": "=YOUR_API_KEY"/);
  assert.match(raw, /"value": "Bearer YOUR_API_KEY"/);
  assert.match(raw, /token YOUR_TELEGRAM_BOT_TOKEN/);
  assert.match(raw, /"value": "250"/, 'short values are not keys');
  assert.equal(found.length, 4);
  const clean = fetcher.redactKeys(JSON.stringify(workflows['111-send-a-telegram-stock-brief'], null, 2));
  assert.deepEqual(clean.found, [], 'apikey={{ $json.key }} is an expression, not a key');
  assert.deepEqual(fetcher.redactKeys(raw).found, [], 'running it twice changes nothing');
});

test('fetch: pages through defuddle, JSON from GitHub with keys removed; an unknown id fails the run', async () => {
  const r = await fetchRun('a', '--ids', '111,222,999');
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /category page: 3 templates/);
  assert.match(r.text, /template 999 is not in crypto-trading/);
  assert.match(r.text, /222: replaced 4 key\(s\)/);
  const md = readFileSync(join(work, 'a', '111-send-a-telegram-stock-brief.md'), 'utf8');
  assert.match(md, /^---\ntitle: "📈 Send a Telegram stock brief"/, md.slice(0, 300));
  assert.match(md, /This workflow is a test fixture\./);
  assert.doesNotMatch(md, /Built by ScraperNode/, 'defuddle drops the site footer');
  const wf = JSON.parse(readFileSync(join(work, 'a', '222-crypto-price-bot-telegram.workflow.json'), 'utf8'));
  assert.equal(wf.nodes[0].parameters.queryParameters.parameters[0].value, '=YOUR_API_KEY');
  assert.ok(existsSync(join(work, 'a', 'crypto-trading.md')));
  assert.ok(!existsSync(join(work, 'a', '333-weekly-sheets-report.md')), 'only the ids asked for');
});

test('fetch again: files already saved are skipped (resume after a cut)', async () => {
  hits.length = 0;
  const r = await fetchRun('a', '--ids', '111');
  assert.equal(r.code, 0, r.text);
  assert.ok(!hits.some((h) => h.includes('111-send')), hits.join(', '));
  assert.match(r.text, /2 file\(s\) were already there/);
});

test('fetch: a dropped connection is tried again; a page that does not exist is not', async () => {
  behaviour.drop.set('/site/templates/crypto-trading/333-weekly-sheets-report/', 2);
  hits.length = 0;
  let r = await fetchRun('b', '--ids', '333');
  assert.equal(r.code, 0, r.text);
  assert.equal(hits.filter((h) => h === '/site/templates/crypto-trading/333-weekly-sheets-report/').length, 3);
  assert.match(r.text, /trying again in 0 s \(2 of 4\)/);
  behaviour.status.set('/site/templates/crypto-trading/111-send-a-telegram-stock-brief/', 404);
  hits.length = 0;
  r = await fetchRun('b', '--ids', '111');
  assert.equal(r.code, 1, r.text);
  assert.equal(hits.filter((h) => h.includes('111-send')).length, 1, 'no retries for a 404');
  assert.match(r.text, /FAIL 111/);
  behaviour.status.clear();
});

test('fetch: site list down → the list from GitHub; --match picks by title', async () => {
  behaviour.status.set('/site/templates/crypto-trading/', 503);
  const r = await fetchRun('c', '--match', 'telegram');
  behaviour.status.clear();
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /using the list on GitHub instead/);
  assert.match(r.text, /GitHub list: 3 templates/);
  assert.ok(existsSync(join(work, 'c', '111-send-a-telegram-stock-brief.workflow.json')));
  assert.ok(existsSync(join(work, 'c', '222-crypto-price-bot-telegram.md')));
  assert.ok(!existsSync(join(work, 'c', '333-weekly-sheets-report.md')));
});

let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`ok    ${t.name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${t.name}\n      ${String(e.stack || e).split('\n').slice(0, 8).join('\n      ')}`);
  }
}
server.close();
rmSync(work, { recursive: true, force: true });
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
