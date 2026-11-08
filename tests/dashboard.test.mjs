#!/usr/bin/env node
// The Vercel dashboard (vercel/public/index.html) in a real browser, against a fake /api/brief: text with & ' < > shows
// as typed (never as &amp; or &#39;), nothing from the data runs as HTML, the 52-week range bars, the trend lines of
// the African shares and the Dangote watch section.
//   node tests/dashboard.test.mjs [brief.json] [--shot=file.png]     (needs Playwright with Chromium)
// With a brief.json (for example the one tests/e2e/run-docker-e2e.mjs saves in the temp folder) it renders that one
// instead and only checks that the page shows it without errors.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const shot = (args.find((a) => a.startsWith('--shot=')) || '').slice(7);
const file = args.find((a) => !a.startsWith('--'));
let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch {
  console.log('skipped: Playwright is not installed');
  process.exit(0);
}

const days = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'];
const series = (vals) => vals.map((c, i) => ({ d: days[i], c }));
const now = Date.now();
const FAKE = {
  generatedAt: new Date(now).toISOString(),
  picks: {
    html: '🌙 <b>US stock picks</b>\nScreen: debt &lt; 30% &amp; cash &lt; 30%, today\'s data',
    data: {
      asOf: 'Sun 8 Nov 2026', checked: 2, passedCount: 1,
      picks: [{ symbol: 'META', name: 'Meta Platforms, Inc.', industry: 'Internet Content & Information', price: 610.15, changePct: 0.84, score: 66, fiscalYear: '2025',
        checks: { debt: { value: 0.054, pass: true }, cash: { value: 0.052, pass: true }, interestIncome: { value: 0.011, pass: true } },
        metrics: { rangePosition: 0.35, revenueGrowth: 0.22, netMargin: 0.3, earningsYield: 0.0388, low: 480, high: 850 } }],
      others: [], failed: [], noData: [],
    },
  },
  africa: {
    html: '🌍 <b>Africa markets brief</b>\nPALM COTE D\'IVOIRE &amp; co',
    data: {
      asOf: 'Sun 8 Nov 2026', errors: {}, hours: { news: 72, x: 24 }, x: { state: 'ok' },
      picks: { ngx: { symbol: 'DANGCEM', name: 'DANGCEM', close: 540, changePct: 1.89, trendPct: 20, trendSessions: 4, value: 1e9 }, brvm: null, bvmac: null },
      ai: { insights: ['PALM COTE D\'IVOIRE led <b>BRVM</b> & more'], sentiment: {}, why: { ngx: 'Steady gains' } },
      feeds: { ngx: { news: [{ id: 'h1', title: 'Shares & bonds: what\'s next <script>alert(1)</script>', source: 'BusinessDay', link: 'https://example.com/a', ts: now - 3600e3, kw: 1 }], posts: [] }, brvm: { news: [], posts: [] }, bvmac: { news: [], posts: [] } },
      ngx: { session: '06/11/2026', count: 3, advancers: 2, decliners: 1, unchanged: 0,
        watchlist: [{ symbol: 'DANGCEM', name: 'DANGCEM', close: 540, changePct: 1.89, screen: true }, { symbol: 'MTNN', name: 'MTNN', close: 400, changePct: -1, screen: true }],
        dangote: [{ symbol: 'DANGCEM', name: 'DANGCEM', close: 540, changePct: 1.89, screen: true }], gainers: [], losers: [],
        closes: { DANGCEM: series([450, 470, 490, 530, 540]), MTNN: series([430, 400]) } },
      brvm: { session: '06/11/2026', count: 1, advancers: 1, decliners: 0, unchanged: 0, watchlist: [{ symbol: 'PALC', name: 'PALM COTE D\'IVOIRE', close: 8000, changePct: 7.31, screen: true }], gainers: [], losers: [], closes: { PALC: series([8000]) } },
      bvmac: { session: '06/11/2026', bulletin: 'n°2633', index: { value: 1123.84, changePct: 0 }, equities: [], unparsed: [], closes: {} },
    },
  },
  dangote: {
    html: '🛢️ <b>Dangote watch</b>',
    data: { lookbackHours: 72, x: { state: 'ok' }, articles: [{ id: 'h1', title: 'Dangote refinery IPO: NGX listing date & price', source: 'Nairametrics', link: 'https://example.com/d', ts: now - 7200e3, kw: 0 }], posts: [],
      shares: [{ symbol: 'DANGCEM', name: 'Dangote Cement Plc', close: 540, changePct: 1.89 }], newListings: [], session: '2026-11-06',
      ipoNote: 'Dangote Petroleum Refinery IPO: 4.1bn shares at ₦525.', ai: { summary: 'Listing expected in December & watched closely.', sentiment: { h1: 1 } } },
  },
};
const brief = file ? JSON.parse(readFileSync(file, 'utf8')) : FAKE;
const page = readFileSync(join(ROOT, 'vercel', 'public', 'index.html'));

const server = createServer((req, res) => {
  if (req.url === '/api/brief') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(brief));
  } else {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page);
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();
let failed = 0;
try {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  const errors = [];
  const dialogs = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  p.on('dialog', (d) => {
    dialogs.push(d.message());
    d.dismiss();
  });
  await p.goto(url);
  await p.waitForFunction(() => !/Loading/.test(document.querySelector('#status').textContent));
  // Open every folded part (the Telegram texts sit in closed <details>), so innerText holds them too.
  const text = await p.evaluate(() => {
    document.querySelectorAll('details').forEach((d) => (d.open = true));
    return document.body.innerText;
  });
  const check = (name, fn) => {
    try {
      fn();
      console.log(`ok    ${name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL  ${name}\n      ${String(e.message).split('\n').slice(0, 4).join('\n      ')}`);
    }
  };
  check('no script error, no dialog', () => {
    assert.deepEqual(errors, []);
    assert.deepEqual(dialogs, []);
  });
  check('the briefs loaded', () => assert.match(text, /Prepared /));
  check('no HTML codes in the visible text', () => assert.doesNotMatch(text, /&amp;|&#0?39;|&lt;|&gt;|&quot;/));
  if (!file) {
    check('& and \' show as typed', () => {
      assert.match(text, /Internet Content & Information/);
      assert.match(text, /PALM COTE D'IVOIRE/);
      assert.match(text, /Shares & bonds: what's next <script>alert\(1\)<\/script>/, 'a headline with tags is shown as text');
      assert.match(text, /Screen: debt < 30% & cash < 30%, today's data/, 'the Telegram message decodes its own codes once');
    });
    check('52-week range bar for each US pick', async () => assert.equal(await p.locator('#picks svg.range').count(), 1));
    const counts = await p.evaluate(() => ({
      africaSparks: document.querySelectorAll('#africa svg.spark').length,
      lookSpark: document.querySelectorAll('#africa .look svg.spark').length,
      dangoteSparks: document.querySelectorAll('#dangote svg.spark').length,
      upLine: document.querySelector('#africa .look svg.spark')?.getAttribute('class'),
      label: document.querySelector('#africa .look svg.spark')?.getAttribute('aria-label'),
    }));
    check('trend lines: the pick, every 🌙 share with 2+ sessions (not PALC with 1), the Dangote shares', () => {
      assert.equal(counts.lookSpark, 1);
      assert.equal(counts.africaSparks, 1 + 3, 'pick + DANGCEM (Dangote table) + DANGCEM and MTNN (watchlist)');
      assert.equal(counts.dangoteSparks, 1);
      assert.equal(counts.upLine, 'spark up');
      assert.match(counts.label, /^5 sessions, 2026-11-02 ₦450\.00 to 2026-11-06 ₦540\.00$/);
    });
    check('Dangote watch section', () => {
      assert.match(text, /Dangote watch: refinery IPO and Dangote shares/);
      assert.match(text, /What it means: Listing expected in December & watched closely\./);
      assert.match(text, /🟢 Dangote refinery IPO: NGX listing date & price/);
      assert.match(text, /Dangote Cement Plc/);
      assert.match(text, /4\.1bn shares at ₦525/);
    });
  }
  // Phone width: no sideways scrolling of the page.
  await p.setViewportSize({ width: 375, height: 800 });
  const wide = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('no horizontal page scroll at phone width', () => assert.ok(wide <= 1, `${wide}px too wide`));
  if (shot) {
    await p.setViewportSize({ width: 1100, height: 900 });
    await p.screenshot({ path: shot, fullPage: true });
  }
} finally {
  await browser.close();
  server.close();
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
