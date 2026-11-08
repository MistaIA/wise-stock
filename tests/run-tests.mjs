#!/usr/bin/env node
// Unit tests for the Code-node sources in src/code. Each file runs exactly as n8n runs a Code node in
// "Run Once for All Items" mode: an async function body with $, $input, $now (Luxon) and $getWorkflowStaticData in
// scope, with its "// #include" lines pasted in as the build does (tools/code-files.mjs).
//   N8N_NODE_MODULES=/path/to/node_modules node tests/run-tests.mjs
// N8N_NODE_MODULES must contain luxon and pdfjs-dist (any n8n install has both). The BOC PDF tests read
// tests/fixtures/boc-sample*.pdf with the same pdfjs call and text joining as n8n's "Extract from File" node.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeSource } from '../tools/code-files.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = join(ROOT, 'tests', 'fixtures');
const NM = process.env.N8N_NODE_MODULES || '/home/claude/n8n-test/node_modules';
const require = createRequire(join(NM, 'noop.js'));
const { DateTime } = require('luxon');
const fixture = (name) => readFileSync(join(FIX, name), 'utf8');
const fixtureJson = (name) => JSON.parse(fixture(name));

// ---------------- n8n Code node emulation ----------------
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const wrap = (list) => list.map((x) => (x && typeof x === 'object' && 'json' in x ? x : { json: x }));
// staticData: the workflow's static data object ($getWorkflowStaticData('global')); left out, the code runs without it.
async function runCode(file, nodes = {}, { input = null, now = '2026-11-06T18:00:00', staticData } = {}) {
  const src = codeSource(ROOT, file);
  const $ = (name) => {
    // n8n throws when a Code node reads a node that did not run in this execution.
    if (!(name in nodes)) throw new Error(`Node '${name}' hasn't been executed`);
    const items = wrap(nodes[name]);
    return { all: () => items, first: () => items[0], last: () => items[items.length - 1] };
  };
  const inputItems = wrap(input || []);
  const $input = { all: () => inputItems, first: () => inputItems[0], last: () => inputItems[inputItems.length - 1] };
  const $now = DateTime.fromISO(now, { zone: 'Africa/Lagos' });
  const getStaticData = staticData && ((type) => {
    assert.equal(type, 'global', 'the workflows only use global static data');
    return staticData;
  });
  const out = await new AsyncFunction('$', '$input', '$now', '$getWorkflowStaticData', src)($, $input, $now, getStaticData);
  assert.ok(Array.isArray(out), `${file} must return an array of items`);
  out.forEach((item) => assert.ok(item && typeof item.json === 'object', `${file} returned an item without json`));
  // n8n serialises items between nodes: make sure the output survives it.
  return JSON.parse(JSON.stringify(out)).map((i) => i.json);
}

// ---------------- Telegram HTML check (parse_mode HTML) ----------------
const TG_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'a', 'code', 'pre', 'blockquote', 'tg-spoiler', 'span']);
function assertTelegramHtml(text, label) {
  assert.ok(typeof text === 'string' && text.length > 0, `${label}: empty message`);
  assert.ok(text.length <= 4096, `${label}: ${text.length} characters, Telegram allows 4096`);
  const stack = [];
  const re = /<(\/?)([a-z-]+)((?:\s[^<>]*)?)>|&(#\d+|#x[0-9a-f]+|[a-z]+);|[<>&]/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[2]) {
      const tag = m[2].toLowerCase();
      assert.ok(TG_TAGS.has(tag), `${label}: tag <${tag}> is not supported by Telegram`);
      if (m[1]) assert.equal(stack.pop(), tag, `${label}: unbalanced </${tag}>`);
      else stack.push(tag);
      if (tag === 'a' && !m[1]) assert.match(m[3], /^\s+href="[^"<>]*"$/, `${label}: bad <a> attributes ${m[3]}`);
    } else if (m[4]) {
      assert.ok(['lt', 'gt', 'amp', 'quot'].includes(m[4].toLowerCase()) || m[4][0] === '#', `${label}: entity &${m[4]}; is not supported`);
    } else {
      assert.fail(`${label}: raw "${m[0]}" must be escaped (at ${m.index}: ${JSON.stringify(text.slice(m.index - 30, m.index + 30))})`);
    }
  }
  assert.equal(stack.length, 0, `${label}: unclosed tags ${stack.join(', ')}`);
}

// ---------------- PDF text exactly like n8n's Extract from File (pdf) ----------------
async function pdfTextLikeN8n(file) {
  if (typeof globalThis.DOMMatrix === 'undefined') {
    globalThis.DOMMatrix = (await import(require.resolve('@thednp/dommatrix'))).default;
  }
  const { getDocument } = await import(require.resolve('pdfjs-dist/legacy/build/pdf.mjs'));
  // Same as n8n-nodes-base/dist/utils/binary.js parseText: items on the same line are joined with no separator.
  const parseText = (textContent) => {
    let lastY;
    const text = [];
    for (const item of textContent.items) {
      if ('str' in item) {
        if (lastY == item.transform[5] || !lastY) text.push(item.str);
        else text.push(`\n${item.str}`);
        lastY = item.transform[5];
      }
    }
    return text.join('');
  };
  const doc = await getDocument({ data: new Uint8Array(readFileSync(join(FIX, file))), verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) pages.push(await (await doc.getPage(i)).getTextContent().then(parseText));
  return pages.join('\n\n');
}

// ---------------- what people see never names a religion (🌙 marks the shares that pass the screen) ----------------
const RELIGIOUS = /halal|haram|shari'?a|islam|muslim|aaoifi|charia|☪/i;
function assertNoReligiousWords(text, label) {
  const m = RELIGIOUS.exec(String(text));
  assert.ok(!m, `${label}: says "${m && m[0]}" (${m && JSON.stringify(String(text).slice(Math.max(0, m.index - 40), m.index + 40))})`);
}

// ---------------- tiny runner ----------------
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const near = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} expected ${b}, got ${a}`);

// ======================================================================
// SM-01 · US stock picks
// ======================================================================
const FMP = fixtureJson('fmp.json');
const fmpItem = (v) => (v && !Array.isArray(v) && v.error ? { error: v.error } : { raw: JSON.stringify(v) });
const UNIVERSE = ['AAPL', 'MSFT', 'NVDA', 'JPM', 'T', 'TSLA', 'SPY', 'AMD', 'XYZ'];
const picksNodes = (cfg = {}) => ({
  Config: [{ universe: UNIVERSE.join(','), topN: 2, maxDebtRatio: 0.3, maxCashRatio: 0.3, maxInterestIncomeRatio: 0.05, source: 'schedule', ...cfg }],
  Universe: UNIVERSE.map((symbol) => ({ symbol })),
  'FMP profile': UNIVERSE.map((s) => fmpItem(FMP[s].profile)),
  'FMP balance sheet': UNIVERSE.map((s) => fmpItem(FMP[s].balance)),
  'FMP income statement': UNIVERSE.map((s) => fmpItem(FMP[s].income)),
});

test('picks-universe: cleans, upper-cases and de-duplicates the watchlist', async () => {
  const out = await runCode('picks-universe', { Config: [{ universe: ' aapl, msft;NVDA  bad$ AAPL brk.b ' }] });
  assert.deepEqual(out.map((j) => j.symbol), ['AAPL', 'MSFT', 'NVDA', 'BRK.B']);
});
test('picks-universe: an empty watchlist stops with a clear error', async () => {
  await assert.rejects(runCode('picks-universe', { Config: [{ universe: ' , ' }] }), /universe is empty/);
});

test('picks-screen: the screen, ratios and the transparent score', async () => {
  const [s] = await runCode('picks-screen', picksNodes());
  assert.equal(s.checked, 9);
  assert.equal(s.passedCount, 4);
  assert.deepEqual(s.picks.map((p) => [p.symbol, p.score]), [['NVDA', 63], ['AAPL', 58]]);
  assert.deepEqual(s.others, [{ symbol: 'MSFT', score: 43 }, { symbol: 'TSLA', score: 35 }]);
  const aapl = s.picks.find((p) => p.symbol === 'AAPL');
  near(aapl.checks.debt.value, 1.12e11 / 3.98e12, 1e-12, 'AAPL debt ratio');
  near(aapl.checks.cash.value, 5.5e10 / 3.98e12, 1e-12, 'AAPL cash ratio');
  assert.equal(aapl.checks.interestIncome.value, 0);
  near(aapl.metrics.rangePosition, (268.5 - 169.21) / (288.62 - 169.21), 1e-12);
  const nvda = s.picks.find((p) => p.symbol === 'NVDA');
  near(nvda.checks.cash.value, (8.6e9 + 3.4e10) / 4.58e12, 1e-12, 'NVDA cash = cash + short-term investments');
  assert.equal(nvda.fiscalYear, '2026');
  const reasons = Object.fromEntries(s.failed.map((f) => [f.symbol, f.reason]));
  assert.match(reasons.JPM, /business activity: Banks - Diversified/);
  assert.equal(reasons.T, 'financial ratios: debt 71.6% ≥ 30.0%');
  assert.match(reasons.SPY, /ETF or fund/);
  const noData = Object.fromEntries(s.noData.map((f) => [f.symbol, f.reason]));
  assert.match(noData.AMD, /not in your FMP plan/);
  assert.match(noData.XYZ, /no data/);
  const facts = JSON.parse(s.aiFacts);
  assert.deepEqual(facts.map((f) => f.symbol), ['NVDA', 'AAPL']);
  assert.equal(facts[1].debtToMarketCapPct, 2.8);
  assert.equal(facts[1].peRatio, Math.round(10 / (1.12e11 / 3.98e12)) / 10);
});
test('picks-screen: TSLA without interestIncome passes with a note; stricter debt limit fails it', async () => {
  const [s] = await runCode('picks-screen', picksNodes({ topN: 5 }));
  const tsla = s.picks.find((p) => p.symbol === 'TSLA');
  assert.equal(tsla.checks.interestIncome.value, null);
  assert.deepEqual(tsla.notes, ['interest income not reported, counted as 0']);
  const [strict] = await runCode('picks-screen', picksNodes({ maxCashRatio: 0.02 }));
  assert.ok(strict.failed.some((f) => f.symbol === 'MSFT' && /cash 2\.5% ≥ 2\.0%/.test(f.reason)), JSON.stringify(strict.failed));
});
test('picks-screen: friendly reasons for a bad key, the daily limit and non-JSON answers', async () => {
  const nodes = picksNodes();
  nodes['FMP profile'][0] = { error: 'Authorization failed - please check your credentials' };
  nodes['FMP profile'][1] = { error: { message: 'The service is receiving too many requests from you' } };
  nodes['FMP profile'][2] = { raw: '<html>maintenance</html>' };
  nodes['FMP profile'][5] = { raw: JSON.stringify({ 'Error Message': 'Invalid API KEY. Feel free to create a Free API Key' }) };
  const [s] = await runCode('picks-screen', nodes);
  const r = Object.fromEntries(s.noData.map((f) => [f.symbol, f.reason]));
  assert.match(r.AAPL, /FMP refused the key/);
  assert.match(r.MSFT, /daily call limit/);
  assert.equal(r.NVDA, 'response was not JSON');
  assert.match(r.TSLA, /FMP refused the key/);
});

test('picks-compose: Telegram HTML with picks, escaped AI text and grouped "no data" reasons', async () => {
  const nodes = picksNodes();
  nodes['FMP profile'][8] = fmpItem(FMP.AMD.profile); // XYZ also outside the plan → one grouped line
  const [screen] = await runCode('picks-screen', nodes);
  const out = await runCode('picks-compose', {
    'Screen & score': [screen],
    'AI explains the picks': [{ text: 'NVIDIA <leads> on growth & margin.\nApple is near its high.' }],
  });
  assert.equal(out.length, 1);
  const t = out[0].text;
  assertTelegramHtml(t, 'US picks');
  assert.match(t, /^🌙 <b>US stock picks<\/b>/);
  assert.match(t, /<i>Screen: debt &lt; 30% and cash &lt; 30% of market cap, interest income &lt; 5% of revenue, no excluded business\.<\/i>/);
  // NVDA: debt 10.3bn, cash 8.6bn + 34bn of a 4.58tn market cap; interest income 1.79bn of 130.5bn revenue.
  assert.match(t, /🥇 <b>NVDA<\/b>[^]*?🌙 Screen: debt 0\.2% ✅ · cash 0\.9% ✅ · interest income 1\.4% ✅ \(FY2026\)/);
  assertNoReligiousWords(t, 'US picks message');
  assert.match(t, /🥇 <b>NVDA<\/b> · NVIDIA Corporation · \$188\.2 \(\+1\.20%\)/);
  assert.match(t, /🥈 <b>AAPL<\/b>/);
  assert.match(t, /Score <b>63\/100<\/b>/);
  assert.match(t, /🧠 <b>Why these 2<\/b>\nNVIDIA &lt;leads&gt; on growth &amp; margin\./);
  assert.match(t, /⚪ AMD, XYZ: not in your FMP plan/);
  assert.match(t, /Information only, not financial advice/);
  assert.equal(out[0].data.picks.length, 2);
});
test('picks-compose: works when the AI step failed or did not run', async () => {
  const [screen] = await runCode('picks-screen', picksNodes());
  const failed = await runCode('picks-compose', { 'Screen & score': [screen], 'AI explains the picks': [{ error: 'OpenAI quota' }] });
  assert.doesNotMatch(failed[0].text, /🧠/);
  const missing = await runCode('picks-compose', { 'Screen & score': [screen] });
  assert.doesNotMatch(missing[0].text, /🧠/);
  assertTelegramHtml(missing[0].text, 'US picks without AI');
});
test('picks-compose: nobody passed', async () => {
  const nodes = picksNodes({ maxDebtRatio: 0.0001 });
  const [screen] = await runCode('picks-screen', nodes);
  assert.equal(screen.picks.length, 0);
  const [msg] = await runCode('picks-compose', { 'Screen & score': [screen], 'AI explains the picks': [{ text: 'x' }] });
  assert.match(msg.text, /No ticker in the watchlist passed the screen today/);
  assert.doesNotMatch(msg.text, /🧠/);
  assertTelegramHtml(msg.text, 'US picks, none passed');
});

// ======================================================================
// SM-02 · Africa markets brief
// ======================================================================
const ngxRaw = fixture('ngx-equities.json');
const brvmRaw = fixture('brvm-cours-actions.html');
const PICK = { bocUrl: 'https://www.bvm-ac.org/wp-content/uploads/2026/11/BOC-20261105.pdf', bocDate: '05/11/2026', bulletinsListed: 4 };
const EXPECTED_BVMAC = {
  SEMC: [52500, 0],
  SAFACAM: [38500, 0],
  SOCAPALM: [49000, 0],
  'LA REGIONALE': [37499, 0],
  BANGE: [228085, 0],
  'SCG-RE': [20000, 0],
  'BGFI HC': [87000, 5.45],
};
// Rows of BOC n°2632 as a text extraction tool returned them (cells separated by " | ").
const TRANSCRIPT_ROWS = [
  'SOCIETE DES EAUX MINERALES DU CAMEROUN | CM 0000010009 | SEM C | SEM C | 52 500 | 04/11/2026 | 0 | 190 | 0 | 0 | 0 | NC | 52 500 | 52 500 | 57 750 | 47 250 | 0,00% | 52 500 | 53 000 | 48 200 | 7,14',
  'SOCIETE AFRICAINE FORESTIERE ET AGRICOLE DU CAMEROUN | CM 0000010017 | SAF | SAFACAM | 38 500 | 04/11/2026 | 3 | 2 | 1 | 0 | 1 | 0 | 385 000 | 3 | PEq | 38 500 | 38 500 | 42 350 | 34 650 | 0,00% | 38 500 | 38 500 | 30 000 | 35,09',
  'SOCIETE CAMEROUNAISE DE PALMERAIE | CM 0000010025 | SOCAP | SOCAPALM | 49 000 | 04/11/2026 | 1 | 2 | 547 | 1 | 2 | 588 000 | 2 | PEq | 49 000 | 49 000 | 53 900 | 44 100 | 0,00% | 49 000 | 55 001 | 49 000 | 1,03',
  'LA REGIONALE EPARGNE CREDIT | CM 0000010041 | REG | LA REGIONALE | 37 499 | 04/11/2026 | 0 | 335 | 0 | 0 | 0 | NC | 37 499 | 37 499 | 41 249 | 33 749 | 0,00% | 37 499 | 42 000 | 37 499 | -10,72',
  'BANCO NACIONAL DE GUINEA ECUATORIAL | GQ0000010050 | BANGE | BANGE | 228 085 | 04/11/2026 | 3 | 5 | 0 | 0 | 0 | 0 | NC | 228 085 | 228 085 | 250 894 | 205 277 | 0,00% | 228 085 | 228 085 | 223 255 | 10,00',
  'SOCIETE COMMERCIALE GABONAISE DE REASSURANCE | GA0000010066 | SCGRE | SCG-Re | 20 000 | 04/11/2026 | 1 | 6 938 | 1 | 20 000 | 1 | PEq | 20 000 | 20 000 | 22 000 | 18 000 | 0,00% | 20 000 | 21 500 | 20 000 | -6,98',
  'BGFI HOLDING CORPORATION | GA0000010074 | BHC | BGFI HC | 82 500 | 04/11/2026 | 5 | 7 781 | 1 | 87 000 | 1 | PEq | 82 500 | 87 000 | 90 750 | 74 250 | 5,45% | 87 000 | 93 051 | 81 000 | -',
];
const COVER = 'BULLETIN OFFICIEL DE LA COTE N° 2632 DU 05/11/2026\nBVMAC ALL SHARE INDEX\n 1 123,84\n2,18%\nBVMAC-AS\nVariation jour\n';
const COMMENT = "\nL'Indice « BVMAC All Share Index » augmente de 2,18% passant de 1 099,87 à 1 123,84 points\n";
const bocText = (rowJoin, cellJoin) => COVER + '\n\nMARCHE DES ACTIONS\n' + TRANSCRIPT_ROWS.map((r) => r.split(' | ').join(cellJoin)).join(rowJoin) + '\nTotal 24 1 080 000 7\n' + COMMENT;
// Headlines and X posts, as Google News and a Nitter mirror send them (RSS 2.0), dated from the tests' $now.
const NOW_MS = Date.parse('2026-11-06T17:00:00Z'); // runCode's default $now: 18:00 in Lagos
const xmlEsc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const rssDoc = (items) => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>feed</title><link>https://example.org/</link>${items.join('')}</channel></rss>`;
const at = (hoursAgo) => new Date(NOW_MS - hoursAgo * 3600e3).toUTCString();
const newsItem = (title, hoursAgo, link, source) =>
  `<item><title>${xmlEsc(title)}</title><link>${xmlEsc(link)}</link><pubDate>${at(hoursAgo)}</pubDate>${source ? `<source url="https://example.org">${xmlEsc(source)}</source>` : ''}</item>`;
const postItem = (text, user, hoursAgo, id) =>
  `<item><title>${xmlEsc(text)}</title><dc:creator>@${user}</dc:creator><description><![CDATA[<p>${xmlEsc(text)}</p>]]></description><pubDate>${at(hoursAgo)}</pubDate><guid>https://nitter.test/${user}/status/${id}#m</guid><link>https://nitter.test/${user}/status/${id}#m</link></item>`;
const NEWS = {
  ngx: rssDoc([
    newsItem('Dangote Cement shares rise as NGX gains 1% | - BusinessDay', 3, 'https://news.google.com/rss/articles/N1?oc=5', 'BusinessDay'),
    newsItem('NGX: banks drop on profit taking - Nairametrics', 5, 'https://news.google.com/rss/articles/N2?oc=5'),
    newsItem('Dangote Cement shares rise as NGX gains 1% - Punch', 4, 'https://news.google.com/rss/articles/N3?oc=5', 'Punch'),
    newsItem('Old story - Vanguard', 100, 'https://news.google.com/rss/articles/N4?oc=5', 'Vanguard'),
    newsItem('Investors <cheer> MTN results & dividend - - Guardian Nigeria', 10, 'https://news.google.com/rss/articles/N5?oc=5', 'Guardian Nigeria'),
  ]),
  brvm: rssDoc([newsItem('La BRVM termine en hausse, Sonatel progresse - Sika Finance', 6, 'https://news.google.com/rss/articles/B1?oc=5', 'Sika Finance')]),
};
const POSTS = {
  ngx: rssDoc([
    postItem('NGX All-Share index climbs to a record as MTN gains', 'naijastocks', 2, '101'),
    postItem('Banks under pressure, Access drops 3% on NGX', 'lagostrader', 5, '102'),
    postItem('Old post about NGX', 'someone', 30, '103'),
  ]),
  brvm: rssDoc([
    postItem('La BRVM en hausse cette semaine, Sonatel bondit', 'abidjanbourse', 3, '201'),
    postItem('La BRVM en hausse cette semaine, Sonatel bondit', 'copycat', 4, '202'),
  ]),
  bvmac: rssDoc([]),
};
const AFRICA_CONFIG = {
  ngxWatchlist: 'DANGCEM,DANGSUGAR,NASCON,MTNN,BUACEMENT,SEPLAT',
  brvmWatchlist: 'SNTS,ORAC,SDCC,PALC,SPHC,TTLC,XXXX',
  topMovers: 3,
  screenExclude: '',
  ngxNewsQuery: 'NGX',
  brvmNewsQuery: 'BRVM',
  bvmacNewsQuery: '',
  newsHours: 72,
  ngxXQuery: 'NGX',
  brvmXQuery: 'BRVM',
  bvmacXQuery: 'BVMAC',
  xHours: 24,
  xMirrors: 'nitter.test, http://backup.test/nitter/',
  source: 'schedule',
};
// The feed nodes as they ran: "Headline feeds" and "X feed list" are the real code, the fetches answer as given.
async function feedNodes({ cfg = AFRICA_CONFIG, news = [{ feedRaw: NEWS.ngx }, { feedRaw: NEWS.brvm }, { error: { message: 'getaddrinfo EAI_AGAIN news.google.com' } }], posts = [{ xRaw: POSTS.ngx }, { xRaw: POSTS.brvm }, { xRaw: POSTS.bvmac }], staticData } = {}) {
  const nodes = {
    'Headline feeds': await runCode('headline-feeds', { Config: [cfg] }),
    'Fetch headlines': news,
    'X feed list': await runCode('x-feed-list', { Config: [cfg] }, { staticData }),
  };
  if (posts) nodes['Fetch X posts'] = posts;
  return nodes;
}
const africaNodes = (bocTextValue, extra = {}, cfg = {}) => ({
  Config: [{ ...AFRICA_CONFIG, ...cfg }],
  'NGX price list': [{ ngxRaw }],
  'BRVM price table': [{ brvmRaw }],
  'BVMAC bulletin index': [{ bocIndexRaw: fixture('boc-index.html') }],
  'Pick latest BOC': [PICK],
  'Read BOC text': [{ text: bocTextValue }],
  ...extra,
});
function checkBvmac(b, label) {
  assert.equal(b.bulletin, 'n°2632 du 05/11/2026', label);
  assert.equal(b.session, '05/11/2026', label);
  assert.deepEqual(b.index, { value: 1123.84, changePct: 2.18 }, label);
  const got = Object.fromEntries(b.equities.map((e) => [e.ticker, [e.close, e.changePct]]));
  assert.deepEqual(got, EXPECTED_BVMAC, `${label}: ${JSON.stringify(b.equities)}`);
  assert.deepEqual(b.unparsed, [], label);
  assert.ok(b.equities.every((e) => !e.isNew), `${label}: bonds must not show up as shares`);
  const screen = Object.fromEntries(b.equities.map((e) => [e.ticker, e.screen]));
  assert.deepEqual(screen, { SEMC: true, SAFACAM: true, SOCAPALM: true, 'LA REGIONALE': false, BANGE: false, 'SCG-RE': false, 'BGFI HC': false });
}

test('africa-build: NGX session, watchlist, breadth, movers, the screen by sector, ticker and board, duplicates', async () => {
  const [d] = await runCode('africa-build', africaNodes(bocText('\n', ' ')));
  assert.deepEqual(d.errors, {});
  const n = d.ngx;
  assert.equal(n.session, '06/11/2026');
  assert.equal(n.count, 13, 'duplicate MTNN row and the broken row are skipped');
  assert.deepEqual(n.watchlist.map((r) => r.symbol), ['DANGCEM', 'DANGSUGAR', 'NASCON', 'MTNN', 'BUACEMENT', 'SEPLAT']);
  assert.equal(n.watchlist.find((r) => r.symbol === 'MTNN').close, 420, 'first MTNN row wins');
  near(n.watchlist.find((r) => r.symbol === 'SEPLAT').changePct, (5500 / 5600 - 1) * 100, 1e-9, 'SEPLAT % computed when PercChange is null');
  assert.deepEqual([n.advancers, n.decliners, n.unchanged, n.notTraded], [6, 4, 2, 1], 'NASCON did not trade');
  assert.deepEqual(n.gainers.map((r) => r.symbol), ['BETAGLAS', 'GTCO', 'MTNN']);
  assert.deepEqual(n.losers.map((r) => r.symbol), ['GUINNESS', 'AIICO', 'DANGSUGAR']);
  const flags = Object.fromEntries([...n.gainers, ...n.losers].map((r) => [r.symbol, r.screen]));
  assert.deepEqual(flags, { BETAGLAS: true, GTCO: false, MTNN: true, GUINNESS: false, AIICO: false, DANGSUGAR: true });
  assert.deepEqual(n.dangote.map((r) => r.symbol), ['DANGCEM', 'DANGSUGAR']);
  assert.ok(!('rows' in n), 'the full list stays out of the output');
  // The live feed names companies by ticker only: the brewer is caught by its ticker, the non-interest bank passes.
  const [withExclude] = await runCode('africa-build', africaNodes(bocText('\n', ' '), {}, { screenExclude: 'betaglas, SNTS' }));
  assert.equal(withExclude.ngx.gainers.find((r) => r.symbol === 'BETAGLAS').screen, false, 'screenExclude');
  assert.equal(withExclude.brvm.watchlist[0].screen, false, 'screenExclude works on every market');
  const facts = JSON.parse(d.aiFacts);
  assert.deepEqual(facts.ngx.breadth, { up: 6, down: 4, unchanged: 2, notTraded: 1 });
  assertNoReligiousWords(d.aiFacts, 'AI facts');
});
test('africa-build: BRVM main table (not the Top 5 table), French numbers, date, missing watchlist ticker', async () => {
  const [d] = await runCode('africa-build', africaNodes(bocText('\n', ' ')));
  const b = d.brvm;
  assert.equal(b.session, '05/11/2026');
  assert.equal(b.count, 10);
  const snts = b.watchlist[0];
  assert.deepEqual([snts.symbol, snts.name, snts.prev, snts.close, snts.changePct, snts.volume, snts.value], ['SNTS', 'SONATEL SENEGAL', 24250, 25000, 3.09, 12345, 12345 * 25000]);
  assert.equal(b.watchlist[1].name, "ORANGE COTE D'IVOIRE");
  assert.equal(b.watchlist[1].volume, 1200);
  assert.deepEqual(b.watchlist.at(-1), { symbol: 'XXXX', missing: true });
  assert.deepEqual([b.advancers, b.decliners, b.unchanged, b.notTraded], [4, 4, 1, 1], 'SDCC volume 0 did not trade');
  assert.deepEqual(b.gainers.map((r) => r.symbol), ['SGBC', 'SNTS', 'PALC']);
  assert.deepEqual(b.losers.map((r) => r.symbol), ['SPHC', 'CFAC', 'SLBC']);
  const flags = Object.fromEntries([...b.gainers, ...b.losers].map((r) => [r.symbol, r.screen]));
  assert.deepEqual(flags, { SGBC: false, SNTS: true, PALC: true, SPHC: true, CFAC: true, SLBC: false });
});
test('africa-build: BVMAC from the real-layout PDF (spaced cells), read like n8n does', async () => {
  const text = await pdfTextLikeN8n('boc-sample.pdf');
  const [d] = await runCode('africa-build', africaNodes(text));
  assert.deepEqual(d.errors, {});
  checkBvmac(d.bvmac, 'spaced PDF');
  assert.equal(d.bvmac.url, PICK.bocUrl);
});
test('africa-build: BVMAC from the PDF whose cells n8n glues together ("NC52 50052 50057 75047 2500,00%")', async () => {
  const text = await pdfTextLikeN8n('boc-sample-glued.pdf');
  assert.match(text, /NC52 50052 50057 75047 2500,00%/, 'fixture really is glued');
  const [d] = await runCode('africa-build', africaNodes(text));
  checkBvmac(d.bvmac, 'glued PDF');
});
test('africa-build: BVMAC from text variants (spaced, glued, line per cell, lost thousands separators)', async () => {
  for (const [label, text] of [
    ['spaced', bocText('\n', ' ')],
    ['glued', bocText('\n', '')],
    ['line per cell', bocText('\n', '\n')],
    ['narrow no-break spaces', bocText('\n', ' ').replace(/(\d) (\d{3})/g, '$1 $2')],
    ['no thousands separator', bocText('\n', ' ').replace(/(\d) (?=\d{3}\b)/g, '$1').replace(/(\d) (?=\d{3}\b)/g, '$1')],
  ]) {
    const [d] = await runCode('africa-build', africaNodes(text));
    assert.deepEqual(d.errors, {}, label);
    checkBvmac(d.bvmac, label);
  }
});
test('africa-build: column-wise PDF layout is refused instead of mixing up shares', async () => {
  const isins = TRANSCRIPT_ROWS.map((r) => r.split(' | ')[1]).join('\n');
  const numbers = TRANSCRIPT_ROWS.map((r) => r.split(' | ').slice(4).join(' ')).join('\n');
  const [d] = await runCode('africa-build', africaNodes(COVER + isins + '\n' + numbers + COMMENT));
  assert.deepEqual(d.bvmac.equities, []);
  assert.equal(d.bvmac.unparsed.length, 7);
  assert.deepEqual(d.bvmac.index, { value: 1123.84, changePct: 2.18 });
});
test('africa-build: index from the commentary when the cover block is unreadable; new share ISIN is reported', async () => {
  const text = bocText('\n', ' ').replace('BVMAC ALL SHARE INDEX', 'BVMAC') + '\nNOUVELLE SOCIETE SA CM0000010090 NSA NOUVELLE 10 000 04/11/2026 0 0 0 0 0 NC 10 000 10 500 11 000 9 000 5,00%\n';
  const [d] = await runCode('africa-build', africaNodes(text));
  assert.deepEqual(d.bvmac.index, { value: 1123.84, changePct: 2.18 });
  const fresh = d.bvmac.equities.find((e) => e.isNew);
  assert.deepEqual([fresh.isin, fresh.close, fresh.changePct, fresh.screen], ['CM0000010090', 10500, 5, null]);
  assert.equal(d.picks.bvmac, null, 'a new share is not screened yet, so it is never the pick');
});
test('africa-build: one broken source does not block the others', async () => {
  const [d] = await runCode('africa-build', africaNodes('', { 'NGX price list': [{ error: { message: 'getaddrinfo ENOTFOUND doclib.ngxgroup.com' } }], 'Pick latest BOC': [{ bocUrl: null, error: 'BOC index page: timeout' }] }));
  assert.match(d.errors.ngx, /ENOTFOUND/);
  assert.match(d.errors.bvmac, /timeout/);
  assert.ok(d.brvm && d.brvm.count === 10);
  assert.deepEqual(d.picks, { ngx: null, brvm: d.picks.brvm, bvmac: null });
  const facts = JSON.parse(d.aiFacts);
  assert.deepEqual(facts.failedSources, ['ngx', 'bvmac']);
  const [d2] = await runCode('africa-build', africaNodes('short', { 'BRVM price table': [{ brvmRaw: '<html><table><tr><td>x</td></tr></table></html>' }] }));
  assert.match(d2.errors.brvm, /table not found/);
  assert.match(d2.errors.bvmac, /empty/);
});

// ---------------- 🌙 to look at: one share per market ----------------
test('africa-build: the 🌙 pick: traded, not falling, at least the median value traded; today\'s change without history', async () => {
  const [d] = await runCode('africa-build', africaNodes(bocText('\n', ' ')));
  // NGX: BETAGLAS (+9.09%) traded only ₦12,000, under the median of the 🌙 shares that traded (SEPLAT, ₦5.5m);
  // CHAMPION (+4%) is a brewer. Among DANGCEM +1.89%, JAIZBANK +3.23% and MTNN +5%, MTNN rose most.
  assert.deepEqual(d.picks.ngx, { symbol: 'MTNN', name: 'MTN NIGERIA COMMUNICATIONS PLC', close: 420, changePct: 5, trendPct: null, trendSessions: null, value: 126000000, score: 5 });
  assert.equal(d.picks.brvm.symbol, 'SNTS', 'SGBC rose more but is a bank');
  assert.equal(d.picks.brvm.value, 12345 * 25000);
  assert.equal(d.picks.bvmac, null, 'the three 🌙 BVMAC shares did not move');
  const [noMtn] = await runCode('africa-build', africaNodes(bocText('\n', ' '), {}, { screenExclude: 'MTNN' }));
  assert.equal(noMtn.picks.ngx.symbol, 'JAIZBANK', 'the non-interest bank passes the screen');
  const facts = JSON.parse(d.aiFacts);
  assert.deepEqual(facts.ngx.pick, { s: 'MTNN', c: 420, ch: 5, trendPct: null, trendSessions: null, valueTraded: 126000000 });
  assert.equal(facts.bvmac.pick, null);
});
test('africa-build: the 5-session trend comes from the closes kept in static data; 10 sessions kept, same session replaced', async () => {
  const days = ['2026-10-30', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'];
  const sd = {
    history: {
      ngx: days.map((day, i) => ({ d: day, c: { DANGCEM: [450, 470, 490, 505, 530][i], MTNN: [430, 425, 420, 410, 400][i] } })),
    },
  };
  const [d] = await runCode('africa-build', africaNodes(bocText('\n', ' ')), { staticData: sd });
  // DANGCEM: 450 → 540 is +20% over 5 sessions, score 0.6 × 20 + 0.4 × 1.89; MTNN fell over the week.
  assert.equal(d.picks.ngx.symbol, 'DANGCEM');
  assert.deepEqual([d.picks.ngx.trendPct, d.picks.ngx.trendSessions, d.picks.ngx.score], [20, 5, 12.76]);
  const kept = sd.history.ngx;
  assert.deepEqual(kept.map((s) => s.d), [...days, '2026-11-06']);
  const today = kept.at(-1).c;
  assert.equal(today.DANGCEM, 540);
  assert.equal(today.JAIZBANK, 3.2);
  assert.ok(!('GTCO' in today) && !('CHAMPION' in today), 'only 🌙 shares are kept');
  // The dashboard's charts: the kept closes of the shares it shows, oldest first, today's close last.
  assert.deepEqual(d.ngx.closes.DANGCEM.map((x) => x.c), [450, 470, 490, 505, 530, 540]);
  assert.deepEqual(d.ngx.closes.DANGCEM.map((x) => x.d), [...days, '2026-11-06']);
  assert.ok(!('CHAMPION' in d.ngx.closes), 'no chart for shares that do not pass the screen');
  assert.ok(Object.keys(d.ngx.closes).every((sym) => [...d.ngx.watchlist, ...(d.ngx.dangote || []), ...d.ngx.gainers, ...d.ngx.losers].some((r) => r.symbol === sym) || sym === d.picks.ngx.symbol), 'only shares the dashboard shows');
  assert.ok(d.bvmac.closes && typeof d.bvmac.closes === 'object');
  assert.deepEqual(sd.history.brvm.map((s) => s.d), ['2026-11-05']);
  assert.deepEqual(sd.history.bvmac.map((s) => s.d), ['2026-11-05']);
  // A second run on the same session replaces it.
  await runCode('africa-build', africaNodes(bocText('\n', ' ')), { staticData: sd });
  assert.equal(sd.history.ngx.length, 6);
  // At most 10 sessions.
  const many = { history: { ngx: Array.from({ length: 12 }, (_, i) => ({ d: `2026-10-${String(10 + i).padStart(2, '0')}`, c: { MTNN: 400 } })) } };
  await runCode('africa-build', africaNodes(bocText('\n', ' ')), { staticData: many });
  assert.equal(many.history.ngx.length, 10);
  assert.deepEqual([many.history.ngx[0].d, many.history.ngx.at(-1).d], ['2026-10-13', '2026-11-06']);
  // An older session than the newest kept (a stale page) leaves the history alone.
  const newer = { history: { ngx: [{ d: '2026-11-09', c: { MTNN: 400 } }] } };
  await runCode('africa-build', africaNodes(bocText('\n', ' ')), { staticData: newer });
  assert.deepEqual(newer.history.ngx, [{ d: '2026-11-09', c: { MTNN: 400 } }]);
});

// ---------------- headlines and X posts ----------------
test('headline-feeds: one Google News search per market, in its language, with a default query', async () => {
  const out = await runCode('headline-feeds', { Config: [{ ...AFRICA_CONFIG, ngxNewsQuery: '"Nigerian Exchange" OR NGX' }] });
  assert.deepEqual(out.map((j) => j.market), ['ngx', 'brvm', 'bvmac']);
  assert.equal(out[0].url, 'https://news.google.com/rss/search?q=%22Nigerian%20Exchange%22%20OR%20NGX&hl=en-NG&gl=NG&ceid=NG:en');
  assert.equal(out[1].url, 'https://news.google.com/rss/search?q=BRVM&hl=fr&gl=CI&ceid=CI:fr');
  assert.equal(out[2].url, 'https://news.google.com/rss/search?q=BVMAC&hl=fr&gl=CM&ceid=CM:fr', 'an empty query falls back to the exchange name');
});
test('x-feed-list: one search per …XQuery key on one mirror; the last mirror that answered goes first; off', async () => {
  const out = await runCode('x-feed-list', { Config: [AFRICA_CONFIG] }, { staticData: {} });
  assert.deepEqual(out.map((j) => [j.market, j.url]), [
    ['ngx', 'https://nitter.test/search/rss?f=tweets&q=NGX'],
    ['brvm', 'https://nitter.test/search/rss?f=tweets&q=BRVM'],
    ['bvmac', 'https://nitter.test/search/rss?f=tweets&q=BVMAC'],
  ]);
  assert.deepEqual([out[0].mirror, out[0].next], ['https://nitter.test', 'http://backup.test/nitter']);
  const sticky = await runCode('x-feed-list', { Config: [AFRICA_CONFIG] }, { staticData: { xMirror: 'http://backup.test/nitter' } });
  assert.deepEqual([sticky[0].url, sticky[0].next], ['http://backup.test/nitter/search/rss?f=tweets&q=NGX', 'https://nitter.test']);
  const gone = await runCode('x-feed-list', { Config: [AFRICA_CONFIG] }, { staticData: { xMirror: 'https://removed.example' } });
  assert.equal(gone[0].mirror, 'https://nitter.test', 'a remembered mirror that left the list is forgotten');
  for (const xMirrors of ['', 'off', ' , ']) {
    const [off] = await runCode('x-feed-list', { Config: [{ ...AFRICA_CONFIG, xMirrors }] });
    assert.deepEqual([off.url, off.off], ['', true], `xMirrors "${xMirrors}"`);
  }
  const dangote = await runCode('x-feed-list', { Config: [{ dangoteXQuery: '"Dangote refinery" OR "Dangote IPO"', xMirrors: 'nitter.test' }] });
  assert.deepEqual(dangote.map((j) => [j.market, j.url]), [['dangote', 'https://nitter.test/search/rss?f=tweets&q=%22Dangote%20refinery%22%20OR%20%22Dangote%20IPO%22']]);
});
test('africa-build: headlines per market (title clean-up, duplicates, 72 h) and X posts (24 h) with ids and keyword ratings', async () => {
  const sd = {};
  const [d] = await runCode('africa-build', africaNodes(bocText('\n', ' '), await feedNodes({ staticData: sd })), { staticData: sd });
  const ngx = d.feeds.ngx;
  assert.deepEqual(ngx.news.map((a) => [a.id, a.title, a.source, a.kw]), [
    ['h1', 'Dangote Cement shares rise as NGX gains 1%', 'BusinessDay', 1],
    ['h2', 'NGX: banks drop on profit taking', 'Nairametrics', 0],
    ['h3', 'Investors <cheer> MTN results & dividend', 'Guardian Nigeria', 1],
  ]);
  assert.equal(ngx.news[0].link, 'https://news.google.com/rss/articles/N1?oc=5');
  assert.deepEqual(d.feeds.brvm.news.map((a) => [a.id, a.title, a.source, a.kw]), [['h4', 'La BRVM termine en hausse, Sonatel progresse', 'Sika Finance', 1]]);
  assert.deepEqual([d.feeds.bvmac.news, d.feeds.bvmac.newsError], [[], 'getaddrinfo EAI_AGAIN news.google.com']);
  assert.deepEqual(ngx.posts.map((p) => [p.id, p.user, p.text, p.kw, p.link]), [
    ['x1', 'naijastocks', 'NGX All-Share index climbs to a record as MTN gains', 1, 'https://nitter.test/naijastocks/status/101'],
    ['x2', 'lagostrader', 'Banks under pressure, Access drops 3% on NGX', -1, 'https://nitter.test/lagostrader/status/102'],
  ]);
  assert.deepEqual(d.feeds.brvm.posts.map((p) => [p.id, p.user]), [['x3', 'abidjanbourse']], 'the same post twice counts once');
  assert.deepEqual(d.feeds.bvmac.posts, []);
  assert.deepEqual(d.x, { state: 'ok', mirror: 'nitter.test', next: null, error: null, why: null });
  assert.equal(sd.xMirror, 'https://nitter.test', 'the mirror that answered is remembered');
  assert.deepEqual(d.hours, { news: 72, x: 24 });
  const facts = JSON.parse(d.aiFacts);
  assert.deepEqual(facts.headlines.map((h) => [h.id, h.market, h.hoursAgo]), [['h1', 'ngx', 3], ['h2', 'ngx', 5], ['h3', 'ngx', 10], ['h4', 'brvm', 6]]);
  assert.deepEqual(facts.posts.map((p) => [p.id, p.market]), [['x1', 'ngx'], ['x2', 'ngx'], ['x3', 'brvm']]);
});
test('africa-build: a mirror that does not answer (error or bot-check page) hands over to the next one; X off', async () => {
  const sd = {};
  const nodes = await feedNodes({ staticData: sd, posts: [{ error: { message: 'Request failed with status code 502' } }, { xRaw: '<html><title>Making sure you are not a bot</title></html>' }, { error: 'timeout of 15000ms exceeded' }] });
  const [d] = await runCode('africa-build', africaNodes(bocText('\n', ' '), nodes), { staticData: sd });
  assert.deepEqual(d.x, { state: 'failed', mirror: 'nitter.test', next: 'backup.test/nitter', error: 'timeout of 15000ms exceeded', why: null });
  assert.equal(sd.xMirror, 'http://backup.test/nitter', 'the next run starts with the next mirror');
  assert.match(d.feeds.brvm.postsError, /web page instead of a feed/);
  assert.deepEqual(d.feeds.ngx.posts, []);
  assert.equal(d.feeds.ngx.news.length, 3, 'headlines do not depend on X');
  // Off: "X on?" sent the item straight to the brief, so "Fetch X posts" did not run.
  const off = await feedNodes({ cfg: { ...AFRICA_CONFIG, xMirrors: '' }, posts: null });
  const [d2] = await runCode('africa-build', africaNodes(bocText('\n', ' '), off));
  assert.deepEqual([d2.x.state, d2.x.why], ['off', 'X posts are off (Config → xMirrors is empty)']);
  // The feed steps did not run at all (an older copy of the workflow): no headlines, no posts, no crash.
  const [d3] = await runCode('africa-build', africaNodes(bocText('\n', ' ')));
  assert.deepEqual([d3.feeds.ngx.news, d3.x.state], [[], 'off']);
});

// ---------------- the Telegram message ----------------
const AI_JSON = {
  insights: ['• NGX: MTNN led with <5%> & volume.', 'BRVM: SNTS rose 3.09%.', 'BVMAC: BGFI HC +5.45%.'],
  sentiment: { h1: 1, h2: -1, h3: 'positive', h4: 0, x1: 1, x2: -1, x3: 1 },
  why: { ngx: 'Biggest gain among the screened shares with strong turnover.', brvm: 'Steady rise on good volume.' },
};
test('africa-compose: Telegram HTML for the three markets, the 🌙 picks, mood, headlines, X posts and the AI insights', async () => {
  const sd = {};
  const [d] = await runCode('africa-build', africaNodes(await pdfTextLikeN8n('boc-sample-glued.pdf'), await feedNodes({ staticData: sd })), { staticData: sd });
  const out = await runCode('africa-compose', { 'Build Africa brief': [d], 'AI insights': [{ text: '```json\n' + JSON.stringify(AI_JSON) + '\n```' }] });
  assert.equal(out.length, 1);
  const t = out[0].text;
  assertTelegramHtml(t, 'africa');
  assertNoReligiousWords(t, 'Africa brief');
  assert.match(t, /🇳🇬 <b>NGX Nigeria<\/b> · session 06\/11\/2026\nBreadth: 6▲ 4▼ 2＝ · 1 not traded \(13 listed\)/);
  assert.match(t, /🟢 DANGCEM ₦540\.00 \(\+1\.89%\) 🌙/);
  assert.match(t, /<b>Top gainers:<\/b> BETAGLAS \(\+9\.09%\) 🌙 · GTCO \(\+5\.26%\) · MTNN \(\+5\.00%\) 🌙/);
  assert.doesNotMatch(t, /🏦/);
  assert.match(t, /🌙 <b>To look at: MTNN<\/b> · ₦420\.00 \(\+5\.00%\) · ₦126\.0m traded\n<i>Biggest gain among the screened shares with strong turnover\.<\/i>/);
  assert.match(t, /🧭 <b>Mood:<\/b> 🟡 mixed · 3 good, 2 bad, 0 neutral\n🟢 <a href="https:\/\/news\.google\.com\/rss\/articles\/N1\?oc=5">Dangote Cement shares rise as NGX gains 1%<\/a> · BusinessDay · 3 h ago/);
  assert.match(t, /🔴 <a href="[^"]+N2[^"]+">NGX: banks drop on profit taking<\/a> · Nairametrics · 5 h ago/);
  assert.match(t, /🟢 <a href="[^"]+N5[^"]+">Investors &lt;cheer&gt; MTN results &amp; dividend<\/a> · Guardian Nigeria · 10 h ago/);
  assert.match(t, /𝕏 <b>2 posts<\/b> in 24 h, latest:\n🟢 <a href="https:\/\/nitter\.test\/naijastocks\/status\/101">@naijastocks<\/a>: NGX All-Share index climbs/);
  assert.match(t, /🟢 SNTS 25\s000 FCFA \(\+3\.09%\) 🌙/);
  assert.match(t, /🌙 <b>To look at: SNTS<\/b> · 25\s000 FCFA \(\+3\.09%\) · 308\.6m FCFA traded\n<i>Steady rise on good volume\.<\/i>/);
  assert.match(t, /🧭 <b>Mood:<\/b> 🟢 positive · 1 good, 0 bad, 1 neutral/, 'BRVM: the AI rated h4 neutral, x3 good');
  assert.match(t, /BVMAC All Share Index <b>1\s123,84<\/b> \(\+2\.18%\)/);
  assert.match(t, /🟢 BGFI HC 87\s000 FCFA \(\+5\.45%\)\n/);
  assert.match(t, /🌙 <b>To look at:<\/b> <i>none today \(no 🌙 share is rising\)<\/i>/);
  assert.match(t, /𝕏 <i>No posts in the last 24 h\.<\/i>/);
  assert.match(t, /<a href="https:\/\/www\.bvm-ac\.org\/wp-content\/uploads\/2026\/11\/BOC-20261105\.pdf">/);
  assert.match(t, /🧠 <b>Insights<\/b>\n• NGX: MTNN led with &lt;5%&gt; &amp; volume\.\n• BRVM: SNTS rose 3\.09%\.\n• BVMAC: BGFI HC \+5\.45%\./);
  assert.match(t, /<i>Not in today's list: XXXX<\/i>/);
  assert.match(t, /⚠️ <b>Source problems today<\/b>\nHeadlines BVMAC: getaddrinfo EAI_AGAIN news\.google\.com/);
  assert.match(t, /<i>🌙 passes the screen \(business activity only; debt not checked\)\. Mood and dots: headlines and X posts rated by the AI\. Information only, not financial advice\.<\/i>$/);
  assert.deepEqual(out[0].data.ai.why, AI_JSON.why);
  assert.equal(out[0].data.ai.sentiment.h3, 'positive');
  assert.equal(out[0].data.picks.ngx.symbol, 'MTNN');
  // OpenAI's JSON mode: n8n's Basic LLM Chain (v1.6+) parses the answer and the item is the object itself.
  const jsonMode = await runCode('africa-compose', { 'Build Africa brief': [d], 'AI insights': [AI_JSON] });
  assert.equal(jsonMode[0].text, t, 'the same message from the parsed object');
});
test('africa-compose: keyword ratings without the AI; an unreadable JSON answer is not shown; a plain answer is', async () => {
  const sd = {};
  const [d] = await runCode('africa-build', africaNodes(bocText('\n', ' '), await feedNodes({ staticData: sd })), { staticData: sd });
  for (const [label, ai] of [
    ['no AI', undefined],
    ['AI failed', [{ error: 'Gemini quota' }]],
    ['broken JSON', [{ text: '{"insights": ["cut off' }]],
  ]) {
    const [msg] = await runCode('africa-compose', { 'Build Africa brief': [d], ...(ai ? { 'AI insights': ai } : {}) });
    assertTelegramHtml(msg.text, label);
    assert.doesNotMatch(msg.text, /🧠|cut off/, label);
    // Keywords: h1 rise/gains good, h2 drop + profit neutral, h3 dividend good, x1 good, x2 bad.
    assert.match(msg.text, /🧭 <b>Mood:<\/b> 🟢 positive · 3 good, 1 bad, 1 neutral\n🟢 <a[^>]+>Dangote Cement[^<]+<\/a>/, label);
    assert.match(msg.text, /rated by keywords \(no AI rating today\)/, label);
    assert.match(msg.text, /🌙 <b>To look at: MTNN<\/b> · ₦420\.00 \(\+5\.00%\) · ₦126\.0m traded\n🧭/, `${label}: no "why" line`);
    assert.equal(msg.data.ai, null, label);
  }
  const [plain] = await runCode('africa-compose', { 'Build Africa brief': [d], 'AI insights': [{ text: 'NGX rose on MTN; BRVM steady.' }] });
  assert.match(plain.text, /🧠 <b>Insights<\/b>\nNGX rose on MTN; BRVM steady\./);
});
test('africa-compose: a market without prices still shows its headlines and posts; X problems are named', async () => {
  const sd = {};
  const nodes = await feedNodes({ staticData: sd, posts: [{ error: 'getaddrinfo ENOTFOUND nitter.test' }, { error: 'getaddrinfo ENOTFOUND nitter.test' }, { error: 'getaddrinfo ENOTFOUND nitter.test' }] });
  const [d] = await runCode('africa-build', africaNodes('', { ...nodes, 'NGX price list': [{ error: 'timeout' }] }), { staticData: sd });
  const [msg] = await runCode('africa-compose', { 'Build Africa brief': [d] });
  assertTelegramHtml(msg.text, 'africa with errors');
  assert.match(msg.text, /🇳🇬 <b>NGX Nigeria<\/b> · <i>no prices today<\/i>\n🧭 <b>Mood:<\/b>/);
  // BVMAC: no bulletin, its headline search failed and X did not answer: nothing to show, the problems say why.
  assert.doesNotMatch(msg.text, /BVMAC \(CEMAC\)/);
  assert.match(msg.text, /🌍 <b>BRVM \(UEMOA\)<\/b> · séance 05\/11\/2026/);
  assert.doesNotMatch(msg.text, /𝕏/, 'no X lines when the mirror did not answer');
  assert.match(msg.text, /⚠️ <b>Source problems today<\/b>\nNGX: timeout\nBVMAC: BOC PDF text is empty \(scanned PDF\?\)\nHeadlines BVMAC: getaddrinfo EAI_AGAIN news\.google\.com\nX posts: no answer from nitter\.test \(getaddrinfo ENOTFOUND nitter\.test\); the next run tries backup\.test\/nitter/);
});
test('compose: a huge block is split into several valid Telegram messages', async () => {
  const [d] = await runCode('africa-build', africaNodes(bocText('\n', ' ')));
  const long = Array.from({ length: 400 }, (_, i) => `• line ${i} with <tag> & text`).join('\n');
  const out = await runCode('africa-compose', { 'Build Africa brief': [d], 'AI insights': [{ text: long }] });
  assert.ok(out.length >= 3, `${out.length} parts`);
  out.forEach((m, i) => assertTelegramHtml(m.text, `part ${i + 1}`));
  assert.deepEqual(out.map((m) => m.part), out.map((_, i) => i + 1));
  assert.ok(out[0].data && out.slice(1).every((m) => m.data === undefined));
});

// ---------------- BVMAC: pick the newest bulletin ----------------
test('bvmac-pick-latest: newest date, absolute or relative links, highest re-upload suffix', async () => {
  const [a] = await runCode('bvmac-pick-latest', {}, { input: [{ bocIndexRaw: fixture('boc-index.html') }] });
  assert.deepEqual(a, { bocUrl: 'https://www.bvm-ac.org/wp-content/uploads/2026/11/BOC-20261105.pdf', bocDate: '05/11/2026', bulletinsListed: 4 });
  const [b] = await runCode('bvmac-pick-latest', {}, { input: [{ bocIndexRaw: '<a href="/wp-content/uploads/2026/10/BOC-20261026-2.pdf">x</a> <a href="/wp-content/uploads/2026/10/BOC-20261026.pdf">y</a> <a href="/wp-content/uploads/2026/10/BOC-20261026-1.pdf">z</a>' }] });
  assert.equal(b.bocUrl, 'https://www.bvm-ac.org/wp-content/uploads/2026/10/BOC-20261026-2.pdf');
  const [c] = await runCode('bvmac-pick-latest', {}, { input: [{ bocIndexRaw: '<p>no links</p>' }] });
  assert.equal(c.bocUrl, null);
  assert.match(c.error, /No BOC PDF link/);
  const [e] = await runCode('bvmac-pick-latest', {}, { input: [{ error: { message: 'Request failed with status code 503' } }] });
  assert.match(e.error, /503/);
});

// ======================================================================
// SM-03 · Dangote watch
// ======================================================================
const RSS = fixtureJson('google-news-rss.json');
const ngxWithRefinery = JSON.stringify([
  ...JSON.parse(ngxRaw),
  { Symbol: 'DANGREF', Company2: 'DANGOTE PETROLEUM REFINERY PLC', Sector: 'OIL AND GAS', ClosePrice: 577.5, PrevClosingPrice: 525, PercChange: 10, Volume: 9000000, TradeDate: '2026-11-06T00:00:00' },
]);
const DANGOTE_CONFIG = { lookbackHours: 12, lookbackHoursOnDemand: 72, knownDangoteSymbols: 'DANGCEM,DANGSUGAR,NASCON', ipoNote: 'IPO note & dates', dangoteXQuery: '"Dangote refinery" OR "Dangote IPO"', xMirrors: 'nitter.test' };
const dangoteNodes = (source, { rss = RSS, ngx = ngxRaw, cfg = {} } = {}) => ({
  Config: [{ ...DANGOTE_CONFIG, source, ...cfg }],
  'Google News RSS': rss,
  'NGX price list': [{ ngxRaw: ngx }],
});
const DANGOTE_POSTS = rssDoc([
  postItem('Dangote refinery IPO demand surges, shares to list in December', 'oilwatcher', 1, '301'),
  postItem('RT by @fan: Dangote refinery delays refunds, investors warn of losses', 'lagosdesk', 3, '302'),
  postItem('Dangote IPO thread from yesterday', 'someone', 20, '303'),
]);
// SM-03 with its X steps: "X feed list" is the real code, "Fetch X posts" answers as given (null: it did not run).
async function dangoteWithX(source, { posts = [{ xRaw: DANGOTE_POSTS }], cfg = {}, staticData, ...rest } = {}) {
  const nodes = dangoteNodes(source, { cfg, ...rest });
  nodes['X feed list'] = await runCode('x-feed-list', { Config: nodes.Config }, { staticData });
  if (posts) nodes['Fetch X posts'] = posts;
  return nodes;
}
test('dangote-find: recent headlines only, de-duplicated, newest first; refinery listing detected', async () => {
  const [f] = await runCode('dangote-find', dangoteNodes('schedule', { ngx: ngxWithRefinery }));
  assert.deepEqual(f.articles.map((a) => [a.title, a.source]), [
    ['Dangote Petroleum Refinery shares to list on NGX in December', 'Reuters'],
    ['Dangote refinery IPO: SEC approves basis of allotment', 'Nairametrics'],
  ]);
  assert.deepEqual(f.shares.map((s) => s.symbol), ['DANGCEM', 'DANGSUGAR', 'NASCON', 'DANGREF']);
  assert.deepEqual(f.newListings.map((s) => s.symbol), ['DANGREF']);
  assert.equal(f.session, '2026-11-06');
  assert.equal(f.shouldReport, true);
  const facts = JSON.parse(f.aiFacts);
  assert.deepEqual(facts.headlines.map((h) => h.hoursAgo), [2, 7.5]);
  assert.deepEqual(facts.newNgxListings, ['DANGREF']);
});
test('dangote-find: on-demand run looks back 72 h and always reports; quiet schedule run stays silent', async () => {
  const [onDemand] = await runCode('dangote-find', dangoteNodes('subworkflow'));
  assert.equal(onDemand.lookbackHours, 72);
  assert.equal(onDemand.articles.length, 3);
  assert.equal(onDemand.shouldReport, true);
  const [quiet] = await runCode('dangote-find', dangoteNodes('schedule', { rss: [{}] }));
  assert.deepEqual([quiet.hasNews, quiet.hasListing, quiet.shouldReport], [false, false, false]);
  const [rssDown] = await runCode('dangote-find', dangoteNodes('schedule', { rss: [{ error: { message: 'getaddrinfo EAI_AGAIN news.google.com' } }] }));
  assert.match(rssDown.newsError, /EAI_AGAIN/);
  assert.equal(rssDown.shares.length, 3);
});
test('dangote-compose: Telegram HTML with the listing alert, escaped links and titles', async () => {
  const [f] = await runCode('dangote-find', dangoteNodes('subworkflow', { ngx: ngxWithRefinery }));
  const out = await runCode('dangote-compose', { 'Find what is new': [f], Config: dangoteNodes('subworkflow').Config, 'AI summary': [{ text: 'Listing expected in December & allotment approved.' }] });
  const t = out[0].text;
  assertTelegramHtml(t, 'dangote');
  assert.match(t, /🚨 <b>New Dangote listing on NGX<\/b>\nDANGREF · DANGOTE PETROLEUM REFINERY PLC · ₦577\.50 \(\+10\.00%\)/);
  assert.match(t, /href="https:\/\/news\.google\.com\/rss\/articles\/CBMiA3\?oc=5&amp;x=&quot;q&quot;"/);
  assert.match(t, /Investors await Dangote &lt;refinery&gt; allotment &amp; refunds<\/a> · Punch Newspapers · 31 h ago/);
  assert.match(t, /📈 <b>Dangote shares on NGX<\/b> · 2026-11-06\nDANGCEM ₦540\.00 \(\+1\.89%\)/);
  assert.match(t, /ℹ️ <i>IPO note &amp; dates<\/i>/);
  const quiet = await runCode('dangote-find', dangoteNodes('subworkflow', { rss: [{}] }));
  const [q] = await runCode('dangote-compose', { 'Find what is new': quiet, Config: dangoteNodes('subworkflow').Config });
  assertTelegramHtml(q.text, 'dangote quiet');
  assert.match(q.text, /No new headlines in the last 72 h/);
});

test('dangote-find: X posts through the mirror (24 h dedup, RT prefix, ratings, ids); X alone does not wake the schedule', async () => {
  const sd = {};
  const [f] = await runCode('dangote-find', await dangoteWithX('schedule', { staticData: sd }), { staticData: sd });
  assert.deepEqual(f.articles.map((a) => [a.id, a.source, a.kw]), [['h1', 'Reuters', 0], ['h2', 'Nairametrics', 1]]);
  assert.deepEqual(f.posts.map((p) => [p.id, p.user, p.text, p.kw, p.link]), [
    ['x1', 'oilwatcher', 'Dangote refinery IPO demand surges, shares to list in December', 1, 'https://nitter.test/oilwatcher/status/301'],
    ['x2', 'lagosdesk', 'Dangote refinery delays refunds, investors warn of losses', -1, 'https://nitter.test/lagosdesk/status/302'],
  ]);
  assert.deepEqual(f.x, { state: 'ok', mirror: 'nitter.test', next: null, error: null, why: null });
  assert.equal(sd.xMirror, 'https://nitter.test');
  const facts = JSON.parse(f.aiFacts);
  assert.deepEqual(facts.headlines.map((h) => h.id), ['h1', 'h2']);
  assert.deepEqual(facts.posts, [
    { id: 'x1', text: 'Dangote refinery IPO demand surges, shares to list in December' },
    { id: 'x2', text: 'Dangote refinery delays refunds, investors warn of losses' },
  ]);
  // Posts about Dangote come every hour: on the schedule they never send a message on their own.
  const [quiet] = await runCode('dangote-find', await dangoteWithX('schedule', { rss: [{}] }));
  assert.deepEqual([quiet.posts.length, quiet.shouldReport], [2, false]);
  // The mirror failed: the next run asks the next one; with one mirror there is no "next".
  const two = {};
  const [down] = await runCode('dangote-find', await dangoteWithX('schedule', { posts: [{ error: { message: 'Request failed with status code 503' } }], cfg: { xMirrors: 'nitter.test other.test' }, staticData: two }), { staticData: two });
  assert.deepEqual(down.x, { state: 'failed', mirror: 'nitter.test', next: 'other.test', error: 'Request failed with status code 503', why: null });
  assert.equal(two.xMirror, 'https://other.test');
  const [alone] = await runCode('dangote-find', await dangoteWithX('schedule', { posts: [{ xRaw: '<html>Just a moment...</html>' }] }));
  assert.deepEqual([alone.x.state, alone.x.next, alone.x.error], ['failed', null, 'it sent a web page instead of a feed (busy, or a bot check)']);
  const [off] = await runCode('dangote-find', await dangoteWithX('schedule', { cfg: { xMirrors: '' }, posts: null }));
  assert.deepEqual([off.x.state, off.posts], ['off', []]);
});
test('dangote-find: Google News titles lose their trailing separators and keep the site name', async () => {
  const ts = (h) => new Date(NOW_MS - h * 3600e3).toISOString();
  const rss = [
    { title: 'Dangote refinery IPO opens today | - MSME Africa', link: 'https://news.google.com/rss/articles/T1', isoDate: ts(1) },
    { title: 'Dangote refinery: what we know - - The Guardian Nigeria', link: 'https://news.google.com/rss/articles/T2', isoDate: ts(2) },
    { title: 'Dangote - the refinery story so far - Reuters', link: 'https://news.google.com/rss/articles/T3', isoDate: ts(3) },
    { title: 'Dangote refinery IPO opens today – Punch', link: 'https://news.google.com/rss/articles/T4', isoDate: ts(4) },
    { title: 'No site name at all', link: 'https://news.google.com/rss/articles/T5', isoDate: ts(5) },
  ];
  const [f] = await runCode('dangote-find', dangoteNodes('schedule', { rss }));
  assert.deepEqual(f.articles.map((a) => [a.title, a.source]), [
    ['Dangote refinery IPO opens today', 'MSME Africa'],
    ['Dangote refinery: what we know', 'The Guardian Nigeria'],
    ['Dangote - the refinery story so far', 'Reuters'],
    ['Dangote refinery IPO opens today – Punch', ''],
    ['No site name at all', ''],
  ]);
});
test('dangote-compose: the AI summary, the mood of headlines and X posts, the X block, and X problems', async () => {
  const [f] = await runCode('dangote-find', await dangoteWithX('schedule'));
  const ai = { summary: 'Allotment approved <today> & listing set for December.', sentiment: { h1: 1, h2: 'positive', x1: 1, x2: -1 } };
  const out = await runCode('dangote-compose', { 'Find what is new': [f], Config: [DANGOTE_CONFIG], 'AI summary': [{ text: 'Here you go:\n```json\n' + JSON.stringify(ai) + '\n```' }] });
  const t = out[0].text;
  assertTelegramHtml(t, 'dangote with X');
  assertNoReligiousWords(t, 'Dangote message');
  assert.match(t, /🧠 <b>What it means<\/b>\nAllotment approved &lt;today&gt; &amp; listing set for December\./);
  assert.match(t, /🧭 <b>Mood:<\/b> 🟢 positive · 3 good, 1 bad, 0 neutral \(headlines and X posts\)/);
  assert.match(t, /📰 <b>Headlines \(last 12 h\)<\/b>\n🟢 <a href="[^"]+CBMiA3[^"]+">Dangote Petroleum Refinery shares to list on NGX in December<\/a> · Reuters · 2 h ago\n🟢 <a/);
  assert.match(t, /𝕏 <b>On X \(last 12 h\)<\/b>: 2 posts, latest:\n🟢 <a href="https:\/\/nitter\.test\/oilwatcher\/status\/301">@oilwatcher<\/a>: Dangote refinery IPO demand surges, shares to list in December · 1 h ago\n🔴 <a href="https:\/\/nitter\.test\/lagosdesk\/status\/302">@lagosdesk<\/a>: Dangote refinery delays refunds, investors warn of losses · 3 h ago/);
  assert.match(t, /<i>Mood and dots: rated by the AI\. Information only, not financial advice\.<\/i>$/);
  assert.deepEqual(out[0].data.ai, ai);
  const jsonMode = await runCode('dangote-compose', { 'Find what is new': [f], Config: [DANGOTE_CONFIG], 'AI summary': [ai] });
  assert.equal(jsonMode[0].text.replace(/ · \d\d:\d\d WAT/, ''), t.replace(/ · \d\d:\d\d WAT/, ''), 'OpenAI JSON mode: the item is the parsed object');
  // Without the AI: keyword ratings (h1 neutral, h2 "approves" good, x1 good, x2 bad); a cut-off JSON answer is hidden.
  for (const [label, aiNode] of [['no AI', undefined], ['broken JSON', [{ text: '{"summary": "cut off' }]]]) {
    const [m] = await runCode('dangote-compose', { 'Find what is new': [f], Config: [DANGOTE_CONFIG], ...(aiNode ? { 'AI summary': aiNode } : {}) });
    assertTelegramHtml(m.text, label);
    assert.doesNotMatch(m.text, /🧠|cut off/, label);
    assert.match(m.text, /🧭 <b>Mood:<\/b> 🟢 positive · 2 good, 1 bad, 1 neutral/, label);
    assert.match(m.text, /📰 <b>Headlines \(last 12 h\)<\/b>\n⚪ <a[^>]+>Dangote Petroleum/, label);
    assert.match(m.text, /rated by keywords \(no AI rating today\)/, label);
  }
  // The mirror did not answer: no X lines, the problem is named with the mirror the next run tries.
  const [g] = await runCode('dangote-find', await dangoteWithX('schedule', { posts: [{ error: 'timeout of 15000ms exceeded' }], cfg: { xMirrors: 'nitter.test,other.test' } }));
  const [m] = await runCode('dangote-compose', { 'Find what is new': [g], Config: [DANGOTE_CONFIG] });
  assertTelegramHtml(m.text, 'dangote X down');
  assert.doesNotMatch(m.text, /𝕏/);
  assert.match(m.text, /⚠️ X posts: no answer from nitter\.test \(timeout of 15000ms exceeded\); the next run tries other\.test/);
  assert.match(m.text, /🧭 <b>Mood:<\/b> [^\n]+ · 1 good, 0 bad, 1 neutral/, 'mood of the headlines only');
});

// ======================================================================
// SM-04 · Market brief API
// ======================================================================
test('api-build-response: merges the three briefs; a missing sub-workflow gives empty fields, not a crash', async () => {
  const [r] = await runCode('api-build-response', {
    'Run Africa brief': [{ text: 'A1', part: 1, data: { ngx: 1 } }, { text: 'A2', part: 2 }],
    'Run stock picks': [{ text: 'H1', data: { picks: [] } }],
    'Run Dangote watch': [{ text: 'D1', data: { shares: [] } }],
  });
  assert.deepEqual(r.africa, { html: 'A1\n\nA2', data: { ngx: 1 } });
  assert.deepEqual(r.picks, { html: 'H1', data: { picks: [] } });
  assert.deepEqual(r.dangote, { html: 'D1', data: { shares: [] } });
  assert.ok(!('halal' in r));
  assert.ok(!Number.isNaN(Date.parse(r.generatedAt)));
  const [empty] = await runCode('api-build-response', { 'Run stock picks': [{ error: 'failed' }] });
  assert.deepEqual(empty.africa, { html: '', data: null });
  assert.deepEqual(empty.picks, { html: '', data: null });
  assert.deepEqual(empty.dangote, { html: '', data: null });
});

// ======================================================================
// Start-up setup (tools/first-run-setup.mjs): the decisions, without n8n (tests/e2e/run-setup-test.mjs runs the CLI)
// ======================================================================
const setup = await import(join(ROOT, 'tools', 'first-run-setup.mjs'));
const repoWorkflows = () => setup.readWorkflows(join(ROOT, 'workflows'));
const nowIn = (list) => new Map(list.map(([w, active = false, archived = false, raw = w.raw]) => [w.json.id, { raw, active, archived }]));

test('setup: plan for new, kept, archived, re-imported and chat-id workflows', async () => {
  const repo = repoWorkflows();
  const byId = Object.fromEntries(repo.map((w) => [w.json.id, w]));
  const first = setup.planWorkflows(repo, new Map(), { chatId: '4242' });
  assert.ok(first.every((i) => i.action === 'new' && !i.activeAfter));
  assert.ok(first.every((i) => !i.raw.includes(setup.CHAT_PLACEHOLDER)), 'chat id written on import');
  assert.equal(JSON.parse(first.find((i) => i.id === 'smHalalPicks0001').raw).nodes.find((n) => n.name === 'Config').parameters.assignments.assignments.find((a) => a.name === 'telegramChatId').value, '4242');

  const editedWithChat = byId.smDangoteWatch01.raw.replace(setup.CHAT_PLACEHOLDER, '777');
  const existing = nowIn([
    [byId.smHalalPicks0001, true], // published, placeholder still there (published by hand)
    [byId.smAfricaBrief001, false, true], // archived
    [byId.smDangoteWatch01, true, false, editedWithChat], // user typed a chat id: never touched
  ]);
  const plan = Object.fromEntries(setup.planWorkflows(repo, existing, { chatId: '4242' }).map((i) => [i.id, i]));
  assert.equal(plan.smHalalPicks0001.action, 'chat-id');
  assert.equal(plan.smHalalPicks0001.activeBefore, true, 'unpublished before the import');
  assert.equal(plan.smHalalPicks0001.activeAfter, false);
  assert.equal(plan.smAfricaBrief001.action, 'archived');
  assert.equal(plan.smDangoteWatch01.action, 'keep');
  assert.equal(plan.smDangoteWatch01.raw, editedWithChat);
  assert.equal(plan.smDangoteWatch01.activeAfter, true);
  assert.equal(plan.smBriefApi000001.action, 'new');

  const noChat = Object.fromEntries(setup.planWorkflows(repo, existing).map((i) => [i.id, i]));
  assert.equal(noChat.smHalalPicks0001.action, 'keep', 'no TELEGRAM_CHAT_ID: placeholder stays');
  const forced = Object.fromEntries(setup.planWorkflows(repo, existing, { chatId: '4242', force: true }).map((i) => [i.id, i]));
  assert.equal(forced.smDangoteWatch01.action, 'reimport');
  assert.equal(forced.smAfricaBrief001.action, 'archived', 'archived stays alone even with SM_REIMPORT_WORKFLOWS');
});

test('setup: publish reasons (REPLACE_ME keys, missing chat id, https trigger, sub-workflows) and order', async () => {
  const repo = repoWorkflows();
  const all = new Set(['Telegram bot', 'OpenAI', 'FMP API key', 'Market brief secret', 'chart-img API key']);
  const realExcept = (...missing) => (c) => all.has(c.name) && !missing.includes(c.name);
  const names = (order) => order.map((i) => i.name.slice(0, 7));

  let items = setup.planWorkflows(repo, new Map(), { chatId: '4242' });
  let reasons = setup.publishPlan(items, { credentialIsReal: realExcept('chart-img API key'), webhookUrl: 'http://localhost:5678/' });
  assert.deepEqual(reasons.get('smHalalPicks0001'), []);
  assert.deepEqual(reasons.get('0pUZ18opxRbimDnS'), ['missing key: chart-img API key']);
  assert.deepEqual(reasons.get('ElKUgro9SMq8kXAo'), ['Telegram Trigger needs N8N_WEBHOOK_URL=https://…']);
  assert.deepEqual(names(setup.publishOrder(items, reasons)), ['SM-01 ·', 'SM-02 ·', 'SM-03 ·', 'SM-04 ·']);
  // The bot answers only the chat it is locked to; n8n applies "Restrict to Chat IDs" from trigger v1.2 on.
  const bot = JSON.parse(items.find((i) => i.id === 'ElKUgro9SMq8kXAo').raw).nodes.find((n) => n.type === 'n8n-nodes-base.telegramTrigger');
  assert.equal(bot.parameters.additionalFields.chatIds, '4242');
  assert.ok(bot.typeVersion >= 1.2, `trigger v${bot.typeVersion} ignores the chat filter`);

  // FMP key missing: SM-01 waits, so SM-04 (which calls it) waits too.
  reasons = setup.publishPlan(items, { credentialIsReal: realExcept('FMP API key'), webhookUrl: 'https://n8n.example.com/' });
  assert.deepEqual(reasons.get('smHalalPicks0001'), ['missing key: FMP API key']);
  assert.match(reasons.get('smBriefApi000001')[0], /^calls an unpublished workflow \(SM-01 · US stock picks/);
  assert.match(reasons.get('ElKUgro9SMq8kXAo')[0], /^calls an unpublished workflow \(SM-01 · US stock picks/, 'WF-11.2 uses SM-01 as a tool');
  assert.deepEqual(names(setup.publishOrder(items, reasons)), ['SM-02 ·', 'SM-03 ·', 'WF-11.1']);

  // No chat id: the three Telegram briefs wait; SM-04 waits for SM-01, SM-02 and SM-03 unless they are published already.
  items = setup.planWorkflows(repo, new Map());
  reasons = setup.publishPlan(items, { credentialIsReal: realExcept(), webhookUrl: '' });
  assert.deepEqual(reasons.get('smDangoteWatch01'), ['TELEGRAM_CHAT_ID not set']);
  assert.ok(reasons.get('ElKUgro9SMq8kXAo').includes('TELEGRAM_CHAT_ID not set'), 'an unlocked bot is never published');
  assert.match(reasons.get('smBriefApi000001')[0], /calls an unpublished workflow/);
  reasons = setup.publishPlan(items, { credentialIsReal: realExcept(), webhookUrl: '', published: new Set(['smHalalPicks0001', 'smAfricaBrief001']) });
  assert.match(reasons.get('smBriefApi000001')[0], /^calls an unpublished workflow \(SM-03 · Dangote watch/, 'the dashboard also shows the Dangote watch');
  reasons = setup.publishPlan(items, { credentialIsReal: realExcept(), webhookUrl: '', published: new Set(['smHalalPicks0001', 'smAfricaBrief001', 'smDangoteWatch01']) });
  assert.deepEqual(reasons.get('smBriefApi000001'), []);

  // Sub-workflows are published before the workflow that calls them, whatever the file order.
  items = setup.planWorkflows([...repo].reverse(), new Map(), { chatId: '4242' });
  reasons = setup.publishPlan(items, { credentialIsReal: realExcept(), webhookUrl: 'https://n8n.example.com/' });
  const order = names(setup.publishOrder(items, reasons));
  assert.ok(order.indexOf('SM-04 ·') > order.indexOf('SM-01 ·') && order.indexOf('SM-04 ·') > order.indexOf('SM-02 ·'), order.join(','));
  assert.ok(order.indexOf('WF-11.2') > order.indexOf('WF-11.1'), order.join(','));
});

test('setup: chat id format and JSON-safe replacement', async () => {
  for (const ok of ['123456789', '-100123456789', '@my_channel']) assert.ok(setup.validChatId(ok), ok);
  for (const bad of ['', '12', 'abc', '@ab', '4242 ', 'https://t.me/x', '"4242"']) assert.ok(!setup.validChatId(bad), bad);
  assert.equal(setup.withChatId('{"v":"YOUR_TELEGRAM_CHAT_ID"}', '@my_channel'), '{"v":"@my_channel"}');
  assert.equal(setup.withChatId('{"v":"YOUR_TELEGRAM_CHAT_ID"}', ''), '{"v":"YOUR_TELEGRAM_CHAT_ID"}');
});

// ---------------- AI provider ----------------
const GEMINI = { provider: 'gemini', model: 'gemini-3.1-flash-lite', modelExplicit: false, notes: [] };
const OPENAI = { provider: 'openai', model: 'gemini-3.1-flash-lite', modelExplicit: false, notes: [] };
const LCN = '@n8n/n8n-nodes-langchain.';

test('setup: AI choice from AI_PROVIDER, GEMINI_API_KEY, OPENAI_API_KEY and GEMINI_MODEL', async () => {
  const choose = (vars) => setup.aiChoice((k) => vars[k] || '');
  assert.deepEqual(choose({}), { provider: 'openai', forced: false, model: 'gemini-3.1-flash-lite', modelExplicit: false, notes: [] });
  assert.equal(choose({ GEMINI_API_KEY: 'g' }).provider, 'gemini', 'only a Gemini key: Gemini');
  assert.equal(choose({ GEMINI_API_KEY: 'g', OPENAI_API_KEY: 'o' }).provider, 'openai', 'both keys: OpenAI, as in the files');
  assert.equal(choose({ GEMINI_API_KEY: 'g', OPENAI_API_KEY: 'o', AI_PROVIDER: 'gemini' }).provider, 'gemini');
  assert.equal(choose({ AI_PROVIDER: 'Google' }).provider, 'gemini');
  assert.equal(choose({ GEMINI_API_KEY: 'g', AI_PROVIDER: 'openai' }).provider, 'openai');
  assert.equal(choose({ GEMINI_API_KEY: 'g', AI_PROVIDER: 'openai' }).forced, true);
  const odd = choose({ GEMINI_API_KEY: 'g', AI_PROVIDER: 'claude', GEMINI_MODEL: 'gemini 2.5' });
  assert.equal(odd.provider, 'gemini');
  assert.equal(odd.forced, false, 'an unknown AI_PROVIDER counts as not set');
  assert.equal(odd.model, 'gemini-3.1-flash-lite');
  assert.equal(odd.notes.length, 2, odd.notes.join(' / '));
  assert.deepEqual(choose({ GEMINI_MODEL: 'models/gemini-2.5-flash-lite' }), { provider: 'openai', forced: false, model: 'gemini-2.5-flash-lite', modelExplicit: true, notes: [] });
});

test('setup: the Gemini switch changes only the AI model nodes, and switching back gives the files again', async () => {
  for (const w of repoWorkflows()) {
    const raw = setup.withAiProvider(w.raw, GEMINI, w.json);
    assert.equal(setup.withAiProvider(w.raw, OPENAI, w.json), w.raw, `${w.file}: already OpenAI, same string back`);
    assert.equal(setup.withAiProvider(w.raw, null, w.json), w.raw);
    if (w.json.id === 'smBriefApi000001') {
      assert.equal(raw, w.raw, 'SM-04 has no AI node');
      continue;
    }
    const g = JSON.parse(raw);
    const fileById = new Map(w.json.nodes.map((n) => [n.id, n]));
    assert.equal(g.nodes.length, w.json.nodes.length);
    assert.ok(!g.nodes.some((n) => n.type === `${LCN}lmChatOpenAi` || n.type === `${LCN}openAi`), `${w.file}: an OpenAI node is left`);
    const names = new Set(g.nodes.map((n) => n.name));
    for (const n of g.nodes) {
      const f = fileById.get(n.id);
      if (n.type === `${LCN}lmChatGoogleGemini`) {
        assert.deepEqual({ v: n.typeVersion, p: n.parameters, c: n.credentials }, { v: 1.2, p: { modelName: 'models/gemini-3.1-flash-lite', options: {} }, c: { googlePalmApi: { id: 'smCredGemini0001', name: 'Google Gemini' } } });
        assert.equal(n.name, f.name.replace('OpenAI', 'Gemini'));
      } else if (n.type === `${LCN}googleGemini`) {
        assert.deepEqual(n.parameters, { resource: 'image', operation: 'analyze', modelId: { __rl: true, mode: 'id', value: 'models/gemini-3.1-flash-lite' }, text: f.parameters.text, inputType: 'binary', binaryPropertyName: 'data', simplify: true, options: {} });
        assert.equal(n.name, 'Gemini');
      } else if (n.name === 'Edit Fields1') {
        const value = n.parameters.assignments.assignments.find((a) => a.name === 'response').value;
        assert.equal(value, "={{ (($('Gemini').item.json.content || {}).parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('') }}");
      } else {
        assert.deepEqual(n, f, `${w.file} › ${n.name} must not change`);
      }
      for (const m of JSON.stringify(n.parameters).matchAll(/\$\(\\?['"]([^'"\\]+)\\?['"]\)/g)) assert.ok(names.has(m[1]), `${w.file} › ${n.name}: refers to missing node "${m[1]}"`);
    }
    for (const [from, outs] of Object.entries(g.connections)) {
      assert.ok(names.has(from), `${w.file}: connection from unknown node ${from}`);
      for (const list of Object.values(outs).flat()) for (const t of list) assert.ok(names.has(t.node), `${w.file}: connection to unknown node ${t.node}`);
    }
    assert.deepEqual(JSON.parse(setup.withAiProvider(raw, OPENAI, w.json)), w.json, `${w.file}: back to OpenAI = the file`);
    assert.equal(setup.withAiProvider(raw, GEMINI, w.json), raw, `${w.file}: already Gemini, nothing to do`);
  }

  const byId = Object.fromEntries(repoWorkflows().map((w) => [w.json.id, w]));
  const picks = byId.smHalalPicks0001;
  const modelNode = (raw) => JSON.parse(raw).nodes.find((n) => n.type === `${LCN}lmChatGoogleGemini`);
  // Gemini 2.x keeps the files' temperature; GEMINI_MODEL changes the model of nodes already on Gemini, a default does not.
  const old = setup.withAiProvider(picks.raw, { ...GEMINI, model: 'gemini-2.5-flash-lite', modelExplicit: true }, picks.json);
  assert.deepEqual(modelNode(old).parameters, { modelName: 'models/gemini-2.5-flash-lite', options: { temperature: 0.2 } });
  assert.equal(setup.withAiProvider(old, GEMINI, picks.json), old, 'no GEMINI_MODEL: the model in n8n is kept');
  const newer = setup.withAiProvider(old, { ...GEMINI, modelExplicit: true }, picks.json);
  assert.deepEqual(modelNode(newer).parameters, { modelName: 'models/gemini-3.1-flash-lite', options: {} });

  // An OpenAI node added by the user (another id) stays; a renamed node keeps its name; a taken name is not reused.
  const wf = JSON.parse(byId['0pUZ18opxRbimDnS'].raw);
  wf.nodes.push({ ...wf.nodes.find((n) => n.name === 'OpenAI'), id: 'user-added-node', name: 'My own OpenAI' });
  wf.nodes.find((n) => n.id === '93aec0f7-03cc-4163-9493-882aa93cea07').name = 'Gemini'; // "HTTP Request1" renamed to Gemini
  wf.connections.Gemini = wf.connections['HTTP Request1'];
  delete wf.connections['HTTP Request1'];
  const mixed = JSON.parse(setup.withAiProvider(JSON.stringify(wf), GEMINI, byId['0pUZ18opxRbimDnS'].json));
  assert.equal(mixed.nodes.find((n) => n.id === 'user-added-node').type, `${LCN}openAi`);
  const vision = mixed.nodes.find((n) => n.id === '9d9e3f80-88a2-4e84-aa6f-577e0c83a109');
  assert.equal(vision.type, `${LCN}googleGemini`);
  assert.equal(vision.name, 'OpenAI', '"Gemini" is taken, the old name stays');
  assert.match(JSON.stringify(mixed.nodes.find((n) => n.name === 'Edit Fields1').parameters), /\$\('OpenAI'\)\.item\.json\.content \|\| \{\}\)\.parts/);

  // planWorkflows: switching only the AI nodes of a copy is "ai-model"; with the chat id at the same time, "chat-id".
  const existing = nowIn([[picks, true], [byId.smAfricaBrief001, true, false, byId.smAfricaBrief001.raw.replace(setup.CHAT_PLACEHOLDER, '777')]]);
  const plan = Object.fromEntries(setup.planWorkflows(repoWorkflows(), existing, { chatId: '4242', ai: GEMINI }).map((i) => [i.id, i]));
  assert.equal(plan.smHalalPicks0001.action, 'chat-id');
  assert.equal(plan.smHalalPicks0001.aiChanged, true);
  assert.equal(plan.smAfricaBrief001.action, 'ai-model');
  assert.equal(plan.smAfricaBrief001.aiChanged, true);
  assert.equal(plan.smAfricaBrief001.activeAfter, false, 'imported, so published again afterwards');
  assert.match(plan.smAfricaBrief001.raw, /"777"/, 'the chat id typed by the user is kept');
  assert.equal(plan.smDangoteWatch01.action, 'new');
  assert.ok(plan.smDangoteWatch01.raw.includes('lmChatGoogleGemini'), 'new imports get Gemini too');
  const again = setup.planWorkflows(repoWorkflows(), nowIn(Object.values(plan).map((i) => [byId[i.id], false, false, i.raw])), { chatId: '4242', ai: GEMINI });
  assert.ok(again.every((i) => i.action === 'keep'), 'the next start changes nothing');
});

test('setup: the briefs publish without an AI key; the Telegram assistant needs one', async () => {
  const repo = repoWorkflows();
  for (const [ai, aiName] of [[OPENAI, 'OpenAI'], [GEMINI, 'Google Gemini']]) {
    const items = setup.planWorkflows(repo, new Map(), { chatId: '4242', ai });
    const real = (c) => c.name !== aiName;
    const reasons = setup.publishPlan(items, { credentialIsReal: real, webhookUrl: 'https://n8n.example.com/' });
    for (const id of ['smHalalPicks0001', 'smAfricaBrief001', 'smDangoteWatch01', 'smBriefApi000001']) assert.deepEqual(reasons.get(id), [], `${aiName}: ${id}`);
    assert.deepEqual(reasons.get('0pUZ18opxRbimDnS'), [`missing key: ${aiName}`]);
    assert.deepEqual(reasons.get('ElKUgro9SMq8kXAo'), [`missing key: ${aiName}`]);
    const raw = (id) => items.find((i) => i.id === id).raw;
    assert.deepEqual(setup.missingOptional(raw('smHalalPicks0001'), real), [aiName]);
    assert.deepEqual(setup.missingOptional(raw('smHalalPicks0001'), () => true), []);
    assert.deepEqual(setup.missingOptional(raw('smBriefApi000001'), real), []);
  }
  // Optional only when every chain the model feeds carries on: needed anywhere = needed.
  const wf = {
    nodes: [
      { name: 'M', type: `${LCN}lmChatOpenAi`, credentials: { openAiApi: { id: 'k', name: 'OpenAI' } } },
      { name: 'Chain', type: `${LCN}chainLlm`, onError: 'continueRegularOutput' },
      { name: 'Agent', type: `${LCN}agent` },
      { name: 'M2', type: `${LCN}lmChatOpenAi`, credentials: { openAiApi: { id: 'k', name: 'OpenAI' } } },
    ],
    connections: { M: { ai_languageModel: [[{ node: 'Chain', type: 'ai_languageModel', index: 0 }]] }, M2: { ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel', index: 0 }]] } },
  };
  assert.equal(setup.requirements(wf).creds[0].optional, false);
  wf.nodes.pop();
  assert.equal(setup.requirements(wf).creds[0].optional, true);
  wf.nodes[1].onError = 'continueErrorOutput';
  assert.equal(setup.requirements(wf).creds[0].optional, false, 'an error branch is not "carry on"');
});

// ======================================================================
// Workflow files: built from these sources, and every $('Node') reference exists
// ======================================================================
test('workflows: Code nodes contain the current src/code files and every $(\'Node\') reference exists', async () => {
  const sources = new Set(readdirSync(join(ROOT, 'src', 'code')).filter((f) => f.endsWith('.js')).map((f) => codeSource(ROOT, f.replace(/\.js$/, ''))));
  for (const file of readdirSync(join(ROOT, 'workflows')).filter((f) => f.endsWith('.json'))) {
    const wf = JSON.parse(readFileSync(join(ROOT, 'workflows', file), 'utf8'));
    const names = new Set(wf.nodes.map((n) => n.name));
    for (const n of wf.nodes) {
      if (n.type === 'n8n-nodes-base.code' && !file.startsWith('WF-11')) assert.ok(sources.has(n.parameters.jsCode), `${file} › ${n.name}: stale code, run node tools/build-workflows.mjs`);
      const text = JSON.stringify(n.parameters);
      for (const m of text.matchAll(/\$\(\\?['"]([^'"\\]+)\\?['"]\)/g)) assert.ok(names.has(m[1]), `${file} › ${n.name}: refers to missing node "${m[1]}"`);
    }
  }
});

// What people read (messages, bot, workflows in the n8n editor, dashboard, API, docs, file names) shows only 🌙. Only
// SM-01's workflow id keeps its first name, so the copy already imported into n8n is updated, not duplicated.
test('wording: what people see never names a religion; only the workflow id of SM-01 keeps its first name', async () => {
  const INTERNAL = /smHalalPicks0001/g;
  for (const dir of ['workflows', 'src/code', 'tools', 'tests', 'windows', 'vercel', 'docker']) {
    for (const f of readdirSync(join(ROOT, dir), { recursive: true })) assert.doesNotMatch(String(f), RELIGIOUS, `file name ${dir}/${f}`);
  }
  const files = [
    ...readdirSync(join(ROOT, 'workflows')).filter((f) => f.endsWith('.json')).map((f) => `workflows/${f}`),
    ...readdirSync(join(ROOT, 'vercel', 'api')).map((f) => `vercel/api/${f}`),
    'vercel/public/index.html',
    'vercel/package.json',
    ...readdirSync(join(ROOT, 'windows')).filter((f) => /\.(cmd|ps1|example)$/.test(f)).map((f) => `windows/${f}`),
    'Dockerfile',
    'docker-compose.yml',
    'docker/entrypoint.sh',
    'README.md',
    'templates/README.md',
    'tools/first-run-setup.mjs',
    'tools/check-sources.mjs',
  ];
  for (const f of files) assertNoReligiousWords(readFileSync(join(ROOT, f), 'utf8').replace(INTERNAL, ''), f);
});

// ---------------- run ----------------
let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`ok    ${t.name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${t.name}\n      ${String(e.stack || e).split('\n').slice(0, 6).join('\n      ')}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
