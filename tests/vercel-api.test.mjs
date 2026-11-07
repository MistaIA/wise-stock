#!/usr/bin/env node
// Tests for the Vercel functions (vercel/api) with a fake fetch: no network, no Vercel CLI.
//   node tests/vercel-api.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const brief = await import(join(ROOT, 'vercel', 'api', 'brief.js'));
const cron = await import(join(ROOT, 'vercel', 'api', 'health-cron.js'));
cron.timing.pause = async () => {}; // no real waiting between health-check tries

const realFetch = globalThis.fetch;
let calls = [];
const fakeFetch = (handler) => {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
};
const setEnv = (vars) => {
  for (const k of ['N8N_BRIEF_URL', 'BRIEF_SECRET', 'N8N_BASE_URL', 'CRON_SECRET', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']) delete process.env[k];
  Object.assign(process.env, vars);
};
const req = (path, headers = {}) => new Request(`https://dash.example.com${path}`, { headers });
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const BRIEF = { generatedAt: '2026-11-07T00:55:13.118Z', picks: { html: '🌙 <b>US stock picks</b>', data: { picks: [] } }, africa: { html: '🌍', data: {} } };

test('brief: passes the secret to n8n and lets the CDN keep the answer 6 h', async () => {
  setEnv({ N8N_BRIEF_URL: 'https://n8n.example.com/webhook/market-brief', BRIEF_SECRET: 's3cret' });
  fakeFetch(() => Response.json(BRIEF));
  const r = await brief.GET(req('/api/brief'));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), BRIEF);
  assert.equal(r.headers.get('cache-control'), 'public, s-maxage=21600, stale-while-revalidate=86400');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://n8n.example.com/webhook/market-brief');
  assert.equal(calls[0].init.headers['X-Brief-Secret'], 's3cret');
});

test('brief: N8N_BASE_URL alone is enough (with or without the last slash); N8N_BRIEF_URL overrides it', async () => {
  for (const base of ['https://wise-stock.up.railway.app', 'https://wise-stock.up.railway.app/', '  https://wise-stock.up.railway.app/  ']) {
    setEnv({ N8N_BASE_URL: base, BRIEF_SECRET: 's3cret' });
    fakeFetch(() => Response.json(BRIEF));
    const r = await brief.GET(req('/api/brief'));
    assert.equal(r.status, 200, base);
    assert.equal(calls[0].url, 'https://wise-stock.up.railway.app/webhook/market-brief', base);
  }
  assert.equal(brief.briefUrl({ N8N_BASE_URL: 'https://host.example/n8n' }), 'https://host.example/n8n/webhook/market-brief', 'n8n under a path');
  assert.equal(brief.briefUrl({ N8N_BASE_URL: 'https://a.example/', N8N_BRIEF_URL: 'https://b.example/webhook/other' }), 'https://b.example/webhook/other');
  assert.equal(brief.briefUrl({ N8N_BASE_URL: 'wise-stock.up.railway.app' }), '', 'no https:// → not used');
  assert.equal(brief.briefUrl({ N8N_BRIEF_URL: 'ftp://x' }), '');
  assert.equal(brief.briefUrl({}), '');
});

test('brief: a query string is redirected to the one cached URL, without calling n8n', async () => {
  setEnv({ N8N_BRIEF_URL: 'https://n8n.example.com/webhook/market-brief', BRIEF_SECRET: 's3cret' });
  fakeFetch(() => Response.json(BRIEF));
  const r = await brief.GET(req('/api/brief?nocache=123'));
  assert.equal(r.status, 308);
  assert.equal(r.headers.get('location'), 'https://dash.example.com/api/brief');
  assert.equal(calls.length, 0);
});

test('brief: clear, uncached errors for missing settings, wrong secret, unpublished SM-04, n8n down, bad JSON', async () => {
  for (const vars of [{}, { N8N_BASE_URL: 'https://n8n.example.com/' }, { BRIEF_SECRET: 's3cret' }]) {
    setEnv(vars);
    const missing = await brief.GET(req('/api/brief'));
    assert.equal(missing.status, 500);
    assert.match((await missing.json()).error, /Set N8N_BASE_URL \(n8n's https address\) and BRIEF_SECRET/);
    assert.equal(missing.headers.get('cache-control'), 'no-store');
  }
  assert.equal(calls.length, 0, 'n8n is not called without both settings');
  setEnv({});
  let r = await brief.GET(req('/api/brief'));
  assert.equal(r.status, 500);
  assert.equal(r.headers.get('cache-control'), 'no-store');

  setEnv({ N8N_BRIEF_URL: 'https://n8n.example.com/webhook/market-brief', BRIEF_SECRET: 'wrong' });
  const cases = [
    [() => new Response('Authorization data is wrong!', { status: 403 }), /HTTP 403: BRIEF_SECRET here differs/],
    [() => new Response('not registered', { status: 404 }), /HTTP 404: SM-04 is not published in n8n, or N8N_BASE_URL is wrong/],
    [() => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }, /did not answer \(ECONNREFUSED\)/],
    [() => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); }, /no answer within 280 s/],
    [() => new Response('<html>', { status: 200 }), /not with JSON/],
    [() => Response.json({ message: 'Workflow was started' }), /without the briefs/],
  ];
  for (const [handler, re] of cases) {
    fakeFetch(handler);
    r = await brief.GET(req('/api/brief'));
    assert.equal(r.status, 502);
    assert.match((await r.json()).error, re);
    assert.equal(r.headers.get('cache-control'), 'no-store');
  }
});

test('vercel.json: Fluid compute on, the brief may run 300 s (Hobby maximum) and waits 280 s for n8n, one cron a day', () => {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'vercel', 'vercel.json'), 'utf8'));
  assert.equal(cfg.fluid, true);
  assert.equal(cfg.outputDirectory, 'public');
  assert.equal(cfg.functions['api/brief.js'].maxDuration, 300);
  assert.ok(cfg.functions['api/health-cron.js'].maxDuration <= 300);
  const src = readFileSync(join(ROOT, 'vercel', 'api', 'brief.js'), 'utf8');
  const wait = Number(/const TIMEOUT_MS = ([\d_]+);/.exec(src)[1].replace(/_/g, ''));
  assert.ok(wait <= cfg.functions['api/brief.js'].maxDuration * 1000 - 10_000, `n8n wait ${wait} ms leaves time to answer`);
  // 3 tries × 15 s + 2 pauses × 5 s must fit in the cron function's time.
  assert.ok(3 * 15 + 2 * 5 < cfg.functions['api/health-cron.js'].maxDuration);
  assert.equal(cfg.crons.length, 1);
  assert.equal(cfg.crons[0].path, '/api/health-cron');
  assert.match(cfg.crons[0].schedule, /^\d+ \d+ \* \* \*$/, 'Hobby allows one run a day');
});

test('health-cron: only Vercel cron (Bearer CRON_SECRET) may run it', async () => {
  setEnv({ CRON_SECRET: 'cron-s', N8N_BASE_URL: 'https://n8n.example.com' });
  fakeFetch(() => new Response('{"status":"ok"}'));
  assert.equal((await cron.GET(req('/api/health-cron'))).status, 401);
  assert.equal((await cron.GET(req('/api/health-cron', { authorization: 'Bearer nope' }))).status, 401);
  assert.equal(calls.length, 0);
  setEnv({ N8N_BASE_URL: 'https://n8n.example.com' });
  assert.equal((await cron.GET(req('/api/health-cron', { authorization: 'Bearer ' }))).status, 401, 'no CRON_SECRET set: refused');
});

test('health-cron: n8n up → 200, no alert', async () => {
  setEnv({ CRON_SECRET: 'cron-s', N8N_BASE_URL: 'https://n8n.example.com', TELEGRAM_BOT_TOKEN: '1:x', TELEGRAM_CHAT_ID: '42' });
  fakeFetch(() => new Response('{"status":"ok"}'));
  const r = await cron.GET(req('/api/health-cron', { authorization: 'Bearer cron-s' }));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, checked: 'https://n8n.example.com/healthz', detail: 'HTTP 200', alerted: false });
  assert.equal(calls.length, 1);
});

test('health-cron: n8n down → 3 tries, Telegram alert, 503', async () => {
  setEnv({ CRON_SECRET: 'cron-s', N8N_BASE_URL: 'https://n8n.example.com/', TELEGRAM_BOT_TOKEN: '1:x', TELEGRAM_CHAT_ID: '42' });
  fakeFetch((url) => {
    if (url.startsWith('https://api.telegram.org/')) return Response.json({ ok: true });
    return new Response('Bad Gateway', { status: 502 });
  });
  const r = await cron.GET(req('/api/health-cron', { authorization: 'Bearer cron-s' }));
  assert.equal(r.status, 503);
  const body = await r.json();
  assert.equal(body.alerted, true);
  assert.equal(body.detail, 'HTTP 502');
  assert.equal(calls.filter((c) => c.url === 'https://n8n.example.com/healthz').length, 3);
  const tg = calls.find((c) => c.url === 'https://api.telegram.org/bot1:x/sendMessage');
  const sent = JSON.parse(tg.init.body);
  assert.equal(sent.chat_id, '42');
  assert.match(sent.text, /n8n is not answering \(https:\/\/n8n\.example\.com\/healthz: HTTP 502, 3 tries\)/);
});

test('health-cron: n8n back on the second try → 200, no alert', async () => {
  setEnv({ CRON_SECRET: 'cron-s', N8N_BASE_URL: 'https://n8n.example.com', TELEGRAM_BOT_TOKEN: '1:x', TELEGRAM_CHAT_ID: '42' });
  let n = 0;
  fakeFetch(() => (++n === 1 ? new Response('', { status: 503 }) : new Response('{"status":"ok"}')));
  const r = await cron.GET(req('/api/health-cron', { authorization: 'Bearer cron-s' }));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).alerted, false);
  assert.ok(!calls.some((c) => c.url.includes('api.telegram.org')));
});

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
globalThis.fetch = realFetch;
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
