#!/usr/bin/env node
// End-to-end test in a real n8n 2.46.6 (the Docker image from this repo) with Postgres, against local mocks.
// Needs Docker. Uses host networking so n8n can reach the mock server on 127.0.0.1:8099.
//   docker build -t stock-market-n8n:test .   then   node tests/e2e/run-docker-e2e.mjs [--keep]
// Checks: start-up setup (credentials, import, publish), the SM-04 webhook (runs SM-02 + SM-01 as published
// sub-workflows), Telegram HTML of both briefs with the 🌙 picks, mood, headlines and X posts, scheduled SM-03 runs
// sending to Telegram, the X mirror list (the first mirror is down: the brief says so, the next run uses the second one,
// remembered in the workflows' static data in Postgres), a restart, and the Telegram bot (WF-11.2): published once
// N8N_WEBHOOK_URL is https, it refuses updates without n8n's secret token and answers only the chat in TELEGRAM_CHAT_ID.
// E2E_AI picks the AI: openai (default, the workflow files as they are), gemini (GEMINI_API_KEY only: the setup
// switches the AI nodes to Google Gemini; the bot also fetches and reads a chart through WF-11.1), none (no AI key:
// the briefs go out without their AI paragraph, the bot stays unpublished).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock, CHART_ANSWER, AFRICA_AI } from './mock-server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const KEEP = process.argv.includes('--keep');
const IMAGE = process.env.E2E_IMAGE || 'stock-market-n8n:test';
const PG = 'sm-e2e-pg';
const N8N = 'sm-e2e-n8n';
const M = 'http://127.0.0.1:8099';
const AI = process.env.E2E_AI || 'openai';
if (!['openai', 'gemini', 'none'].includes(AI)) throw new Error(`E2E_AI must be openai, gemini or none, not ${AI}`);
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (m) => console.log(`\n== ${m}`);
// What people read never names a religion: 🌙 marks the shares that pass the screen.
const RELIGIOUS = /halal|haram|shari'?a|islam|muslim|aaoifi|charia|☪/i;
// The prompt an AI call carried (OpenAI messages or Gemini contents), as text.
const promptOf = (l) => {
  const b = JSON.parse(l.body || '{}');
  const parts = [...(b.messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')), ...(b.contents || []).flatMap((c) => (c.parts || []).map((p) => p.text || '')), ...((b.systemInstruction && b.systemInstruction.parts) || []).map((p) => p.text || '')];
  return parts.join(' ');
};
// The workflow's global static data as n8n saved it in Postgres (the X mirror that answered, the closes of the last
// sessions). The column holds { global: {...}, "node:Schedule": {...} }: $getWorkflowStaticData('global') is "global".
const staticData = (id) => {
  const out = docker('exec', PG, 'psql', '-U', 'n8n', '-d', 'n8n', '-tAc', `select "staticData" from workflow_entity where id = '${id}'`).trim();
  return out ? JSON.parse(out).global || null : null;
};

// Same Telegram HTML rules as tests/run-tests.mjs
const TG_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'a', 'code', 'pre', 'blockquote', 'tg-spoiler', 'span']);
function assertTelegramHtml(text, label) {
  assert.ok(text && text.length <= 4096, `${label}: length ${text && text.length}`);
  const stack = [];
  for (const m of text.matchAll(/<(\/?)([a-z-]+)((?:\s[^<>]*)?)>|&(#\d+|#x[0-9a-f]+|[a-z]+);|[<>&]/gi)) {
    if (m[2]) {
      assert.ok(TG_TAGS.has(m[2].toLowerCase()), `${label}: tag <${m[2]}>`);
      if (m[1]) assert.equal(stack.pop(), m[2].toLowerCase(), `${label}: unbalanced`);
      else stack.push(m[2].toLowerCase());
    } else if (m[4]) assert.ok(['lt', 'gt', 'amp', 'quot'].includes(m[4]) || m[4][0] === '#', `${label}: &${m[4]};`);
    else assert.fail(`${label}: raw ${m[0]}`);
  }
  assert.equal(stack.length, 0, `${label}: unclosed`);
}

// Test copy of the workflows: outside URLs → mock, SM-03 every minute so its scheduled path runs during the test,
// SM-01 and SM-02 moved to 1 January so a real 07:30 or 18:00 can't fire them in the middle of the test.
function testWorkflows() {
  const dir = join(tmpdir(), 'sm-e2e-workflows');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const swaps = [
    ['https://doclib.ngxgroup.com/REST/api/statistics/equities/?market=&sector=&orderby=&pageSize=400&pageNo=0', `${M}/ngx`],
    ['https://www.brvm.org/fr/cours-actions/0', `${M}/brvm`],
    ['https://www.bvm-ac.org/bulletin-officiel-de-la-cote-boc/', `${M}/boc-index`],
    ['https://www.bvm-ac.org${path}', `${M}\${path}`],
    ['https://financialmodelingprep.com/stable/', `${M}/fmp/`],
    ['https://news.google.com/rss/search?q=', `${M}/rss?q=`],
    ['https://api.chart-img.com/', `${M}/chart-img/`],
    // X posts: the first mirror of the list is down, the second answers.
    ['"value": "nitter.kareem.one"', `"value": "${M}/nitter-down, ${M}/nitter"`],
    ['"expression": "0 0 8,18 * * *"', '"expression": "0 * * * * *"'],
    ['"expression": "0 30 7 * * 1-5"', '"expression": "0 0 0 1 1 *"'],
    ['"expression": "0 0 18 * * 1-5"', '"expression": "0 0 0 1 1 *"'],
  ];
  for (const f of readdirSync(join(ROOT, 'workflows')).filter((x) => x.endsWith('.json'))) {
    let raw = readFileSync(join(ROOT, 'workflows', f), 'utf8');
    for (const [a, b] of swaps) raw = raw.split(a).join(b);
    writeFileSync(join(dir, f), raw);
  }
  return dir;
}

const ENV = {
  DB_TYPE: 'postgresdb',
  DB_POSTGRESDB_HOST: '127.0.0.1',
  DB_POSTGRESDB_DATABASE: 'n8n',
  DB_POSTGRESDB_USER: 'n8n',
  DB_POSTGRESDB_PASSWORD: 'e2e-pass',
  N8N_ENCRYPTION_KEY: 'e2e-encryption-key-0123456789abcdef',
  N8N_WEBHOOK_URL: 'http://127.0.0.1:5678/',
  // The sandbox's host network has no IPv6, and n8n listens on '::' by default.
  N8N_LISTEN_ADDRESS: '0.0.0.0',
  TELEGRAM_BOT_TOKEN: '123456:TEST',
  TELEGRAM_CHAT_ID: '4242',
  TELEGRAM_API_BASE_URL: `${M}/telegram`,
  // none: the OpenAI credential is created with REPLACE_ME and pointed at the mock, which refuses it (401).
  ...{ openai: { OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: `${M}/openai/v1` }, gemini: { GEMINI_API_KEY: 'gm-test', GEMINI_API_BASE_URL: `${M}/gemini` }, none: { OPENAI_BASE_URL: `${M}/openai/v1` } }[AI],
  FMP_API_KEY: 'fmp-test',
  BRIEF_SECRET: 'e2e-secret',
  N8N_AUTO_PUBLISH: 'true',
  SM_WORKFLOWS_DIR: '/opt/e2e-workflows',
};

async function waitHealthy(timeoutMs = 240000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch('http://127.0.0.1:5678/healthz');
      if (r.ok) return;
    } catch {}
    await sleep(2000);
  }
  throw new Error(`n8n not healthy after ${timeoutMs / 1000}s\n${docker('logs', '--tail', '80', N8N)}`);
}

// /healthz answers before the published workflows are activated (about 3 s later), so wait until the
// SM-04 webhook exists: without the secret it answers 401/403 once registered and 404 before.
async function waitWebhookRegistered(timeoutMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch('http://127.0.0.1:5678/webhook/market-brief');
      if (r.status !== 404) return;
    } catch {}
    await sleep(1000);
  }
  throw new Error(`SM-04 webhook still not registered after ${timeoutMs / 1000}s`);
}

const cleanup = () => {
  for (const c of [N8N, PG]) {
    try {
      docker('rm', '-f', c);
    } catch {}
  }
};

const { server, log } = await startMock();
cleanup();
try {
  step('Postgres');
  docker('run', '-d', '--name', PG, '--network', 'host', '-e', 'POSTGRES_USER=n8n', '-e', 'POSTGRES_PASSWORD=e2e-pass', '-e', 'POSTGRES_DB=n8n', 'postgres:17-alpine');
  for (let i = 0; i < 60; i++) {
    try {
      docker('exec', PG, 'pg_isready', '-U', 'n8n', '-h', '127.0.0.1');
      break;
    } catch {
      await sleep(1000);
    }
  }

  step('n8n (first start: setup imports and publishes)');
  const wfDir = testWorkflows();
  const envArgs = Object.entries(ENV).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  docker('run', '-d', '--name', N8N, '--network', 'host', '-v', `${wfDir}:/opt/e2e-workflows:ro`, ...envArgs, IMAGE);
  await waitHealthy();
  await waitWebhookRegistered();
  const setupLog = docker('logs', N8N).split('\n').filter((l) => l.includes('[stock-market setup]'));
  console.log(setupLog.join('\n'));
  for (const name of ['SM-01', 'SM-02', 'SM-03', 'SM-04']) assert.ok(setupLog.some((l) => l.includes('published "' + name)), `${name} published`);
  assert.ok(setupLog.some((l) => /not published "WF-11\.1.*chart-img/.test(l)), 'WF-11.1 waits for its chart-img key');
  assert.ok(setupLog.some((l) => /not published "WF-11\.2/.test(l)), 'WF-11.2 waits (no https URL, WF-11.1 unpublished)');
  if (AI === 'gemini') {
    assert.ok(setupLog.some((l) => l.includes('AI: Google Gemini, default model gemini-3.1-flash-lite')), 'Gemini chosen');
    assert.ok(setupLog.some((l) => l.includes('credential "Google Gemini": set from GEMINI_API_KEY')));
  }
  if (AI === 'none') {
    assert.ok(setupLog.some((l) => l.includes('no AI key yet')));
    for (const name of ['SM-01', 'SM-02', 'SM-03']) assert.ok(setupLog.some((l) => l.includes(`published "${name}`) && l.endsWith('(no AI paragraph yet: no OpenAI key)')), `${name} published without AI`);
  }

  step('SM-04 webhook auth');
  const denied = await fetch('http://127.0.0.1:5678/webhook/market-brief');
  assert.ok([401, 403].includes(denied.status), `no secret → ${denied.status}`);

  step('SM-04 webhook → SM-02 + SM-01 as sub-workflows');
  const before = log.length; // SM-03 runs every minute in this test, so only look at the calls made during the request
  const r = await fetch('http://127.0.0.1:5678/webhook/market-brief', { headers: { 'X-Brief-Secret': 'e2e-secret' } });
  const text = await r.text();
  assert.equal(r.status, 200, text.slice(0, 500));
  const brief = JSON.parse(text);
  writeFileSync(join(tmpdir(), 'sm-e2e-brief.json'), JSON.stringify(brief, null, 2));
  console.log(brief.africa.html, '\n----\n', brief.picks.html);
  assertTelegramHtml(brief.africa.html, 'africa');
  assertTelegramHtml(brief.picks.html, 'picks');
  assert.doesNotMatch(text, RELIGIOUS, 'the API answer (both briefs and their data)');
  assert.ok(!('halal' in brief), 'the API calls the US picks "picks"');
  assert.match(brief.picks.html, /^🌙 <b>US stock picks<\/b>/);
  assert.match(brief.africa.html, /🟢 DANGCEM ₦540\.00 \(\+1\.89%\) 🌙/);
  assert.match(brief.africa.html, /🟢 SNTS 25\s000 FCFA \(\+3\.09%\) 🌙/);
  assert.match(brief.africa.html, /BVMAC All Share Index <b>1\s123,84<\/b> \(\+2\.18%\)/);
  assert.match(brief.africa.html, /🟢 BGFI HC 87\s000 FCFA \(\+5\.45%\)\n/);
  assert.match(brief.africa.html, /🌙 <b>To look at: MTNN<\/b> · ₦420\.00 \(\+5\.00%\) · ₦126\.0m traded/);
  assert.match(brief.africa.html, /🌙 <b>To look at: SNTS<\/b> · 25\s000 FCFA \(\+3\.09%\) · 308\.6m FCFA traded/);
  assert.match(brief.africa.html, /🌙 <b>To look at:<\/b> <i>none today \(no 🌙 share is rising\)<\/i>/, 'BVMAC: the 🌙 shares did not move');
  assert.match(brief.africa.html, /<a href="https:\/\/news\.google\.com\/rss\/articles\/N1\?oc=5">Dangote Cement shares rise as NGX gains 1%<\/a> · BusinessDay · 3 h ago/);
  assert.match(brief.africa.html, /<a href="https:\/\/news\.google\.com\/rss\/articles\/B1\?oc=5">La BRVM termine en hausse, Sonatel progresse<\/a> · Sika Finance · 5 h ago/);
  // The first mirror is down: no X lines, the brief names it and the mirror the next run asks.
  assert.doesNotMatch(brief.africa.html, /𝕏/);
  assert.match(brief.africa.html, /⚠️ <b>Source problems today<\/b>\nX posts: no answer from 127\.0\.0\.1:8099\/nitter-down \([^\n]*503[^\n]*\); the next run tries 127\.0\.0\.1:8099\/nitter\n\n<i>🌙 passes the screen/);
  if (AI === 'none') {
    assert.doesNotMatch(brief.africa.html + brief.picks.html, /🧠/, 'no AI paragraph without an AI key');
    assert.match(brief.africa.html, /🧭 <b>Mood:<\/b> 🟢 positive · 2 good, 0 bad, 1 neutral\n/, 'NGX headlines rated by keywords');
    assert.match(brief.africa.html, /rated by keywords \(no AI rating today\)\./);
    assert.equal(brief.africa.data.ai, null);
  } else {
    assert.match(brief.africa.html, /🧠 <b>Insights<\/b>\n• NGX: MTNN led the screened shares\.\n• BRVM: SNTS rose 3\.09% on good volume\.\n• BVMAC: BGFI HC \+5\.45%\./);
    assert.match(brief.africa.html, /₦126\.0m traded\n<i>Biggest gain among the screened shares, &lt;on&gt; good volume &amp; turnover\.<\/i>/);
    assert.match(brief.africa.html, /🧭 <b>Mood:<\/b> 🟢 positive · 2 good, 1 bad, 0 neutral\n/, 'NGX headlines rated by the AI (h2 bad)');
    assert.match(brief.africa.html, /rated by the AI\./);
    assert.deepEqual(brief.africa.data.ai.why, AFRICA_AI.why);
  }
  assert.match(brief.picks.html, /🥇 <b>NVDA<\/b>/);
  assert.match(brief.picks.html, /🥈 <b>AAPL<\/b>/);
  if (AI !== 'none') assert.match(brief.picks.html, /🧠 <b>Why these 2<\/b>\nNVIDIA leads on growth and margins/);
  assert.match(brief.picks.html, /AMD: not in your FMP plan/);
  assert.equal(brief.picks.data.picks.length, 2);
  assert.equal(brief.africa.data.bvmac.equities.length, 7);
  const during = log.slice(before);
  const fmpCalls = during.filter((l) => l.path.startsWith('/fmp/')).length;
  assert.equal(fmpCalls, 30, `FMP calls for 10 tickers × 3 endpoints, no retries (got ${fmpCalls})`);
  const briefSends = during.filter((l) => l.path.startsWith('/telegram/') && /US stock picks|Africa markets brief/.test(l.body));
  // SM-03 runs every minute in this test: leave its Dangote searches out.
  const news = during.filter((l) => l.path === '/rss' && !/Dangote/.test(l.query.q)).map((l) => l.query.q);
  assert.deepEqual(news, ['"Nigerian Exchange" OR NGX OR "Nigerian stocks"', 'BRVM', 'BVMAC'], 'SM-02: one Google News search per market');
  const xAsked = during.filter((l) => /^\/nitter/.test(l.path) && !/Dangote/.test(l.query.q));
  assert.deepEqual(xAsked.map((l) => [l.path, l.query.q]), [['/nitter-down/search/rss', 'NGX OR NGXASI OR "Nigerian stocks"'], ['/nitter-down/search/rss', 'BRVM'], ['/nitter-down/search/rss', 'BVMAC']]);
  for (let i = 1; i < xAsked.length; i++) assert.ok(xAsked[i].at - xAsked[i - 1].at >= 1000, `X searches ${xAsked[i].at - xAsked[i - 1].at} ms apart`);
  assert.ok(xAsked.every((l) => /^StockMarketBrief\/1\.0 /.test(l.headers['user-agent'])), 'an honest User-Agent');
  assert.equal(briefSends.length, 0, 'API mode sends nothing to Telegram');
  const aiCalls = during.filter((l) => /^\/(openai|gemini)\//.test(l.path));
  if (AI === 'gemini') {
    assert.ok(aiCalls.length >= 2 && aiCalls.every((l) => l.path === '/gemini/v1beta/models/gemini-3.1-flash-lite:generateContent' && l.headers['x-goog-api-key'] === 'gm-test'), aiCalls.map((l) => l.path).join(', '));
    const req = JSON.parse(aiCalls[0].body);
    assert.equal(req.generationConfig?.temperature, undefined, 'Gemini 3 keeps its default temperature');
    assert.equal(req.generationConfig?.maxOutputTokens, undefined, 'no token cap');
  } else if (AI === 'none') {
    assert.ok(aiCalls.length >= 2 && aiCalls.every((l) => l.path === '/openai/v1/chat/completions' && l.headers.authorization === 'Bearer REPLACE_ME'), 'the AI call fails (401) and the brief goes on');
  } else {
    assert.ok(aiCalls.length >= 2 && aiCalls.every((l) => l.path === '/openai/v1/chat/completions'));
    const africaCall = aiCalls.find((l) => /\{"insights"/.test(promptOf(l)));
    assert.ok(africaCall, 'SM-02 asked the AI for its JSON');
    assert.deepEqual(JSON.parse(africaCall.body).response_format, { type: 'json_object' }, 'OpenAI JSON mode');
    assert.ok(aiCalls.some((l) => !/\{"insights"/.test(promptOf(l)) && JSON.parse(l.body).response_format === undefined), 'SM-01 asks for plain text');
  }

  step('SM-04 again: X posts come from the second mirror, remembered in the static data of SM-02');
  const sd = staticData('smAfricaBrief001');
  assert.equal(sd && sd.xMirror, `${M}/nitter`, `static data after the first run: ${JSON.stringify(sd).slice(0, 300)}`);
  assert.deepEqual(sd.history.ngx.map((x) => x.d), ['2026-11-06'], 'the closes of the 🌙 shares are kept for the trend');
  assert.equal(sd.history.ngx[0].c.DANGCEM, 540);
  assert.ok(!('GTCO' in sd.history.ngx[0].c), 'only 🌙 shares are kept');
  const r2 = await fetch('http://127.0.0.1:5678/webhook/market-brief', { headers: { 'X-Brief-Secret': 'e2e-secret' } });
  assert.equal(r2.status, 200);
  const brief2 = await r2.json();
  console.log(brief2.africa.html);
  assertTelegramHtml(brief2.africa.html, 'africa, second run');
  assert.match(brief2.africa.html, /𝕏 <b>2 posts<\/b> in 24 h, latest:\n🟢 <a href="http:\/\/127\.0\.0\.1:8099\/nitter\/naijastocks\/status\/101">@naijastocks<\/a>: NGX All-Share index climbs to a record as MTN gains\n🔴 <a href="http:\/\/127\.0\.0\.1:8099\/nitter\/lagostrader\/status\/102">@lagostrader<\/a>: Banks under pressure/);
  assert.match(brief2.africa.html, /𝕏 <b>1 post<\/b> in 24 h, latest:\n🟢 <a[^>]+>@abidjanbourse<\/a>/);
  assert.match(brief2.africa.html, /𝕏 <i>No posts in the last 24 h\.<\/i>/, 'BVMAC: the search answered with no post');
  assert.doesNotMatch(brief2.africa.html, /Source problems/);
  assert.equal(brief2.africa.data.x.state, 'ok');
  assert.equal(staticData('smAfricaBrief001').history.ngx.length, 1, 'the same session is replaced, not added');

  step('SM-03 on its (test) schedule → Telegram; its first run finds the first mirror down, the next one uses the second');
  const dangoteSends = () => log.filter((l) => /\/telegram\/bot123456:TEST\/sendMessage$/.test(l.path) && /Dangote watch/.test(l.body)).map((l) => JSON.parse(l.body));
  for (let i = 0; i < 75 && dangoteSends().length === 0; i++) await sleep(2000);
  assert.ok(dangoteSends().length >= 1, 'SM-03 sent a Telegram message');
  const msg = dangoteSends()[0];
  console.log(msg.text);
  assert.equal(String(msg.chat_id), '4242');
  assert.equal(msg.parse_mode, 'HTML');
  assert.equal(msg.disable_web_page_preview, true);
  assertTelegramHtml(msg.text, 'dangote');
  assert.match(msg.text, /🛢️ <b>Dangote watch<\/b>/);
  assert.match(msg.text, /Dangote Petroleum Refinery shares to list on NGX in December<\/a> · Reuters · 2 h ago/);
  if (AI === 'none') assert.doesNotMatch(msg.text, /🧠/);
  else assert.match(msg.text, /🧠 <b>What it means<\/b>\nAllotment approved; listing expected in December &lt;check&gt; &amp; refunds pending\./);
  assert.doesNotMatch(msg.text, /Investors await/, '31 h old headline is outside the 12 h schedule window');
  assert.doesNotMatch(msg.text, RELIGIOUS);
  assert.doesNotMatch(msg.text, /𝕏/);
  assert.match(msg.text, /⚠️ X posts: no answer from 127\.0\.0\.1:8099\/nitter-down \([^\n]*503[^\n]*\); the next run tries 127\.0\.0\.1:8099\/nitter/);
  if (AI === 'none') assert.match(msg.text, /🧭 <b>Mood:<\/b> 🟢 positive · 1 good, 0 bad, 1 neutral \(headlines and X posts\)/);
  else assert.match(msg.text, /🧭 <b>Mood:<\/b> 🟢 positive · 2 good, 0 bad, 0 neutral \(headlines and X posts\)/);
  for (let i = 0; i < 45 && dangoteSends().length < 2; i++) await sleep(2000);
  const next = dangoteSends()[1];
  assert.ok(next, 'SM-03 ran again a minute later');
  console.log(next.text);
  assertTelegramHtml(next.text, 'dangote, second run');
  assert.match(next.text, /𝕏 <b>On X \(last 12 h\)<\/b>: 2 posts, latest:\n🟢 <a href="http:\/\/127\.0\.0\.1:8099\/nitter\/oilwatcher\/status\/301">@oilwatcher<\/a>: Dangote refinery IPO demand surges, shares to list in December · (\d+ min|1 h) ago\n🔴 <a href="[^"]+">@lagosdesk<\/a>: Dangote refinery delays refunds, investors warn of losses · 3 h ago/);
  assert.doesNotMatch(next.text, /⚠️/);
  assert.equal(staticData('smDangoteWatch01').xMirror, `${M}/nitter`);

  step('restart: setup keeps the imported workflows');
  const restartAt = new Date().toISOString();
  docker('restart', N8N);
  await waitHealthy();
  await waitWebhookRegistered();
  const second = docker('logs', '--since', restartAt, N8N).split('\n').filter((l) => l.includes('[stock-market setup]'));
  console.log(second.join('\n'));
  assert.ok(second.some((l) => l.includes('all workflows already in n8n')), 'no re-import on restart');
  assert.ok(!second.some((l) => /\] (imported \d+ workflow|published ")/.test(l)), 'restart neither re-imports nor re-publishes');
  assert.ok(second.some((l) => /chart-img API key": still REPLACE_ME/.test(l)), 'placeholder credential is recognised, not recreated');
  const again = await fetch('http://127.0.0.1:5678/webhook/market-brief', { headers: { 'X-Brief-Secret': 'e2e-secret' } });
  assert.equal(again.status, 200, 'still published after restart');
  const afterRestart = await again.json();
  assert.match(afterRestart.africa.html, /𝕏 <b>2 posts<\/b>/, 'the mirror that answered is still remembered after a restart');
  assert.doesNotMatch(afterRestart.africa.html, /nitter-down/);

  step('Telegram bot (WF-11.2): https URL + chart-img key → published; answers only TELEGRAM_CHAT_ID');
  docker('rm', '-f', N8N);
  const botAt = log.length;
  const botEnv = { ...ENV, N8N_WEBHOOK_URL: 'https://n8n.e2e.test/', CHART_IMG_API_KEY: 'chart-test' };
  docker('run', '-d', '--name', N8N, '--network', 'host', '-v', `${wfDir}:/opt/e2e-workflows:ro`, ...Object.entries(botEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]), IMAGE);
  await waitHealthy();
  await waitWebhookRegistered();
  const third = docker('logs', N8N).split('\n').filter((l) => l.includes('[stock-market setup]'));
  console.log(third.join('\n'));
  if (AI === 'none') {
    // No AI key: the assistant can't answer, so it is not published, whatever else is ready.
    assert.ok(third.some((l) => /not published "WF-11\.1.*missing key: OpenAI/.test(l)), 'WF-11.1 waits for an AI key');
    assert.ok(third.some((l) => /not published "WF-11\.2.*missing key: OpenAI/.test(l)), 'WF-11.2 waits for an AI key');
  } else {
    assert.ok(third.some((l) => l.includes('published "WF-11.1')), 'WF-11.1 published once its key is set');
    assert.ok(third.some((l) => l.includes('published "WF-11.2')), 'WF-11.2 published once the URL is https');
    let hook;
    for (let i = 0; i < 60 && !hook; i++) {
      hook = log.slice(botAt).find((l) => /\/telegram\/bot123456:TEST\/setWebhook$/.test(l.path));
      if (!hook) await sleep(1000);
    }
    assert.ok(hook, 'n8n registered the bot webhook with Telegram');
    const reg = JSON.parse(hook.body);
    assert.ok(reg.url.startsWith('https://n8n.e2e.test/webhook/'), reg.url);
    const local = reg.url.replace('https://n8n.e2e.test/', 'http://127.0.0.1:5678/');
    const update = (chatId, id, headers = { 'x-telegram-bot-api-secret-token': reg.secret_token }, text = 'Which stocks look good today? bot-format-test') =>
      fetch(local, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ update_id: id, message: { message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'private' }, from: { id: chatId, is_bot: false, first_name: 'Test' }, text } }),
      });
    assert.equal((await update(4242, 1, {})).status, 403, 'an update without the secret token is refused');
    const stranger = await update(999, 2);
    assert.ok(stranger.status < 500, `stranger's update → HTTP ${stranger.status}`);
    const own = await update(4242, 3);
    assert.ok(own.status < 500, `own update → HTTP ${own.status}`);
    const replies = () => log.slice(botAt).filter((l) => /\/sendMessage$/.test(l.path) && !/Dangote watch/.test(l.body)).map((l) => JSON.parse(l.body));
    for (let i = 0; i < 90 && !replies().some((m) => String(m.chat_id) === '4242'); i++) await sleep(1000);
    console.log(replies());
    const answer = replies().find((m) => String(m.chat_id) === '4242');
    assert.ok(answer, 'the bot answered the chat in TELEGRAM_CHAT_ID');
    // The AI's Markdown becomes safe Telegram HTML, so a stray < or & can't make Telegram refuse the reply.
    assert.equal(answer.parse_mode, 'HTML');
    assert.equal(answer.text, '<b>NVDA</b> leads &lt;today&gt; &amp; AAPL follows.\n<b>Note</b>\nNot financial advice.');
    assertTelegramHtml(answer.text, 'bot reply');
    await sleep(3000);
    assert.ok(!replies().some((m) => String(m.chat_id) === '999'), 'the bot ignored the stranger');

    if (AI === 'gemini') {
      step('Telegram bot on Gemini: getChart tool → WF-11.1 (chart-img, image upload, Gemini reads the chart) → answer');
      const chartAt = log.length;
      const asked = await update(4242, 4, undefined, 'Can you analyse the NVDA chart? chart-test');
      assert.ok(asked.status < 500, `chart question → HTTP ${asked.status}`);
      const chartReply = () => log.slice(chartAt).filter((l) => /\/sendMessage$/.test(l.path) && !/Dangote watch/.test(l.body)).map((l) => JSON.parse(l.body)).find((m) => String(m.chat_id) === '4242');
      for (let i = 0; i < 120 && !chartReply(); i++) await sleep(1000);
      const calls = log.slice(chartAt).map((l) => `${l.method} ${l.path}`);
      console.log(calls.join('\n'), '\n', chartReply());
      const chartImg = log.slice(chartAt).find((l) => l.path === '/chart-img/v2/tradingview/advanced-chart/storage');
      assert.ok(chartImg, 'WF-11.1 asked chart-img for the chart');
      assert.equal(chartImg.headers['x-api-key'], 'chart-test');
      assert.equal(JSON.parse(chartImg.body).symbol, 'NASDAQ:NVDA');
      const uploaded = log.slice(chartAt).find((l) => /^\/gemini\/upload-session\//.test(l.path));
      assert.ok(uploaded && uploaded.png, 'the chart image was uploaded to Gemini as PNG');
      const read = log.slice(chartAt).find((l) => /:generateContent$/.test(l.path) && l.query.key === 'gm-test' && /fileData/.test(l.body));
      assert.ok(read, 'the Gemini node asked the model to read the uploaded chart');
      assert.ok(log.slice(chartAt).some((l) => /models\/gemini-3\.1-flash-lite:/.test(l.path) && /"thoughtSignature":"sig-e2e"/.test(l.body)), 'the thought signature went back with the tool result');
      assert.equal(chartReply()?.text, CHART_ANSWER, 'the answer is built from the chart analysis');
    }
  }
  console.log('\nE2E OK');
} catch (e) {
  console.error('\nE2E FAILED:', e.message);
  try {
    console.error(docker('logs', '--tail', '120', N8N));
  } catch {}
  process.exitCode = 1;
} finally {
  server.close();
  if (!KEEP) cleanup();
}
