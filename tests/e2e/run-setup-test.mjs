#!/usr/bin/env node
// Start-up setup against the real n8n 2.46.6 CLI (Docker image of this repo, SQLite), over nine starts that share
// one n8n folder. n8n itself is not started; only tools/first-run-setup.mjs runs, the way the entrypoint runs it.
// It uses N8N_BIN_JS (node + n8n's entry script), the same way windows/start-n8n.ps1 runs it.
//   docker build -t stock-market-n8n:test .   then   node tests/e2e/run-setup-test.mjs
// Checked: REPLACE_ME keys never get a workflow published; a key or chat id added later gets it published on the next
// start; SM_REIMPORT_WORKFLOWS works over published workflows; publishing respects sub-workflow order; the Telegram bot
// (WF-11.2) is locked to TELEGRAM_CHAT_ID; the briefs are published without an AI key; GEMINI_API_KEY switches the
// AI nodes of the copies in n8n to Gemini (and GEMINI_MODEL their model), and OpenAI switches them back to the files.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const IMAGE = process.env.E2E_IMAGE || 'stock-market-n8n:test';
const data = mkdtempSync(join(tmpdir(), 'sm-setup-test-'));
chmodSync(data, 0o777); // the image runs as user "node"

const BASE = {
  N8N_USER_FOLDER: '/data',
  N8N_ENCRYPTION_KEY: 'setup-test-key-0123456789',
  N8N_BIN_JS: '/usr/local/lib/node_modules/n8n/bin/n8n',
  N8N_AUTO_PUBLISH: 'true',
  N8N_DIAGNOSTICS_ENABLED: 'false',
};
const KEYS = { TELEGRAM_BOT_TOKEN: '123:abc', OPENAI_API_KEY: 'sk-x', FMP_API_KEY: 'fmp-x', BRIEF_SECRET: 'secret-x' };
const { OPENAI_API_KEY, ...NO_AI } = KEYS;
const GEMINI = { ...NO_AI, GEMINI_API_KEY: 'gm-x', TELEGRAM_CHAT_ID: '4242', CHART_IMG_API_KEY: 'chart-x' };
const ROOT_WF = (f) => JSON.parse(readFileSync(join(ROOT, 'workflows', f), 'utf8'));
const shape = (wf) => wf.nodes.map(({ id, name, type, typeVersion, parameters, credentials }) => ({ id, name, type, typeVersion, parameters, credentials })).sort((a, b) => a.id.localeCompare(b.id));

function docker(args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
}
function run(label, extra) {
  const envArgs = Object.entries({ ...BASE, ...extra }).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const out = docker(['run', '--rm', '-v', `${data}:/data`, '-v', `${join(ROOT, 'tools')}:/opt/stock-market/tools:ro`, ...envArgs, '--entrypoint', 'node', IMAGE, '/opt/stock-market/tools/first-run-setup.mjs']);
  const lines = out.split('\n').filter((l) => l.startsWith('[stock-market setup]'));
  console.log(`\n== ${label}\n${lines.join('\n')}`);
  return lines;
}
const active = () => {
  const out = docker(['run', '--rm', '-v', `${data}:/data`, '-e', 'N8N_USER_FOLDER=/data', '-e', `N8N_ENCRYPTION_KEY=${BASE.N8N_ENCRYPTION_KEY}`, '--entrypoint', 'n8n', IMAGE, 'list:workflow', '--active=true', '--onlyId']);
  return out.split('\n').map((l) => l.trim()).filter((l) => /^[A-Za-z0-9]{16}$/.test(l)).sort();
};
const workflowInN8n = (id) => {
  docker(['run', '--rm', '-v', `${data}:/data`, '-e', 'N8N_USER_FOLDER=/data', '-e', `N8N_ENCRYPTION_KEY=${BASE.N8N_ENCRYPTION_KEY}`, '--entrypoint', 'n8n', IMAGE, 'export:workflow', `--id=${id}`, '--output=/data/export-check.json']);
  const [wf] = JSON.parse(readFileSync(join(data, 'export-check.json'), 'utf8')); // --id writes an array
  return wf;
};
const has = (lines, re) => lines.some((l) => re.test(l));
const published = (lines) => lines.filter((l) => /\] published "/.test(l)).map((l) => l.match(/published "([^"]+)"/)[1].slice(0, 7));

try {
  // 1. First start with no keys and no chat id: placeholders, import, nothing published. The briefs don't wait for
  //    an AI key (they go out without their AI paragraph); the Telegram assistant does.
  let l = run('1. no keys, no chat id', {});
  assert.ok(has(l, /AI: OpenAI, model gpt-4o-mini/));
  assert.ok(has(l, /no AI key yet/));
  assert.ok(has(l, /credential "OpenAI": created with REPLACE_ME/));
  assert.ok(!has(l, /credential "Google Gemini"/));
  assert.ok(has(l, /imported 6 workflow\(s\)/));
  assert.deepEqual(published(l), []);
  assert.ok(has(l, /not published "SM-01.*missing key: FMP API key, Telegram bot; TELEGRAM_CHAT_ID not set$/));
  assert.ok(has(l, /not published "WF-11\.2.*missing key: Telegram bot, OpenAI;/));
  assert.ok(has(l, /not published "SM-04.*missing key: Market brief secret$/));

  // 2. Same again: the REPLACE_ME credentials are recognised, so still nothing is published.
  l = run('2. restart, still no keys', {});
  assert.ok(has(l, /credential "OpenAI": still REPLACE_ME/));
  assert.ok(has(l, /all workflows already in n8n/));
  assert.deepEqual(published(l), []);
  assert.deepEqual(active(), []);

  // 3. Keys and chat id added: the chat id is written into the copies in n8n, everything that can run is published,
  //    sub-workflows (SM-01, SM-02) before SM-04 which calls them.
  l = run('3. keys + TELEGRAM_CHAT_ID added', { ...KEYS, TELEGRAM_CHAT_ID: '4242' });
  assert.ok(has(l, /wrote TELEGRAM_CHAT_ID into: SM-01 .*\| SM-02 .*\| SM-03 .*\| WF-11\.2/));
  assert.deepEqual(published(l), ['SM-01 ·', 'SM-02 ·', 'SM-03 ·', 'SM-04 ·']);
  assert.ok(has(l, /not published "WF-11\.1.*missing key: chart-img API key/));
  assert.deepEqual(active(), ['smAfricaBrief001', 'smBriefApi000001', 'smDangoteWatch01', 'smHalalPicks0001']);
  // The bot is locked to that chat in the copy n8n holds (Telegram Trigger v1.5, "Restrict to Chat IDs").
  const trigger = workflowInN8n('ElKUgro9SMq8kXAo').nodes.find((n) => n.type === 'n8n-nodes-base.telegramTrigger');
  assert.equal(trigger.parameters.additionalFields.chatIds, '4242');
  assert.equal(trigger.typeVersion, 1.5);

  // 4. Re-import over the published copies: n8n needs them unpublished first; they are published again afterwards.
  l = run('4. SM_REIMPORT_WORKFLOWS=true', { ...KEYS, TELEGRAM_CHAT_ID: '4242', SM_REIMPORT_WORKFLOWS: 'true' });
  assert.ok(has(l, /re-imported over the copies in n8n/));
  assert.deepEqual(published(l), ['SM-01 ·', 'SM-02 ·', 'SM-03 ·', 'SM-04 ·']);
  assert.deepEqual(active(), ['smAfricaBrief001', 'smBriefApi000001', 'smDangoteWatch01', 'smHalalPicks0001']);

  // 5. chart-img key added later: WF-11.1 is published; nothing else is touched.
  l = run('5. CHART_IMG_API_KEY added', { ...KEYS, TELEGRAM_CHAT_ID: '4242', CHART_IMG_API_KEY: 'chart-x' });
  assert.ok(has(l, /all workflows already in n8n/));
  assert.deepEqual(published(l), ['WF-11.1']);
  assert.ok(has(l, /not published "WF-11\.2.*https/));
  assert.equal(active().length, 5);

  // 6. Only a Gemini key: the AI nodes of the copies in n8n become Gemini nodes; the workflows that were published
  //    are published again after the import; SM-04 (no AI node) is not touched; the OpenAI credential is left alone.
  l = run('6. GEMINI_API_KEY instead of OPENAI_API_KEY', GEMINI);
  assert.ok(has(l, /AI: Google Gemini, default model gemini-3\.1-flash-lite \(GEMINI_MODEL picks another\)/));
  assert.ok(has(l, /credential "Google Gemini": set from GEMINI_API_KEY/));
  assert.ok(!has(l, /credential "OpenAI"/));
  assert.ok(has(l, /AI nodes set to Google Gemini \(gemini-3\.1-flash-lite\) in the copies in n8n: SM-01 [^|]*\| SM-02 [^|]*\| SM-03 [^|]*\| WF-11\.1[^|]*\| WF-11\.2/));
  assert.deepEqual(published(l), ['SM-01 ·', 'SM-02 ·', 'SM-03 ·', 'WF-11.1']);
  assert.equal(active().length, 5);
  let chart = workflowInN8n('0pUZ18opxRbimDnS');
  const vision = chart.nodes.find((n) => n.name === 'Gemini');
  assert.equal(vision.type, '@n8n/n8n-nodes-langchain.googleGemini');
  assert.equal(vision.parameters.modelId.value, 'models/gemini-3.1-flash-lite');
  assert.equal(vision.parameters.inputType, 'binary');
  assert.deepEqual(vision.credentials, { googlePalmApi: { id: 'smCredGemini0001', name: 'Google Gemini' } });
  assert.match(JSON.stringify(chart.nodes.find((n) => n.name === 'Edit Fields1').parameters), /\$\('Gemini'\)\.item\.json\.content/);
  assert.ok(chart.connections.Gemini && !chart.connections.OpenAI && chart.connections['HTTP Request1'].main[0][0].node === 'Gemini');
  let model = workflowInN8n('smHalalPicks0001').nodes.find((n) => n.name === 'Gemini model');
  assert.equal(model.type, '@n8n/n8n-nodes-langchain.lmChatGoogleGemini');
  assert.equal(model.parameters.modelName, 'models/gemini-3.1-flash-lite');
  assert.deepEqual(model.parameters.options, {}, 'Gemini 3: default temperature, no token cap');

  // 7. GEMINI_MODEL changes the model of those nodes (Gemini 2.x keeps the files' temperature).
  l = run('7. GEMINI_MODEL=gemini-2.5-flash-lite', { ...GEMINI, GEMINI_MODEL: 'gemini-2.5-flash-lite' });
  assert.ok(has(l, /AI: Google Gemini, model gemini-2\.5-flash-lite \(GEMINI_MODEL\)/));
  assert.ok(has(l, /AI nodes set to Google Gemini \(gemini-2\.5-flash-lite\) in the copies in n8n: SM-01 [^|]*\| SM-02 [^|]*\| SM-03 [^|]*\| WF-11\.1[^|]*\| WF-11\.2/));
  model = workflowInN8n('smHalalPicks0001').nodes.find((n) => n.name === 'Gemini model');
  assert.equal(model.parameters.modelName, 'models/gemini-2.5-flash-lite');
  assert.deepEqual(model.parameters.options, { temperature: 0.2 });
  assert.equal(workflowInN8n('0pUZ18opxRbimDnS').nodes.find((n) => n.name === 'Gemini').parameters.modelId.value, 'models/gemini-2.5-flash-lite');

  // 8. Without GEMINI_MODEL the model in n8n is kept (it may have been picked in the editor): nothing is imported.
  l = run('8. GEMINI_MODEL removed', GEMINI);
  assert.ok(has(l, /all workflows already in n8n/));
  assert.deepEqual(published(l), []);

  // 9. Both keys, no AI_PROVIDER: OpenAI, as in the files; the copies get the files' OpenAI nodes back.
  l = run('9. OPENAI_API_KEY back (both keys set)', { ...GEMINI, OPENAI_API_KEY: 'sk-x' });
  assert.ok(has(l, /AI: OpenAI, model gpt-4o-mini/));
  assert.ok(has(l, /AI nodes set to OpenAI \(gpt-4o-mini\) in the copies in n8n: SM-01 [^|]*\| SM-02 [^|]*\| SM-03 [^|]*\| WF-11\.1[^|]*\| WF-11\.2/));
  assert.deepEqual(published(l), ['SM-01 ·', 'SM-02 ·', 'SM-03 ·', 'WF-11.1']);
  chart = workflowInN8n('0pUZ18opxRbimDnS');
  const file = ROOT_WF('WF-11.1-stock-chart-analyst.json');
  assert.deepEqual(shape(chart), shape(file), 'WF-11.1 in n8n has the file\'s nodes again');
  assert.deepEqual(chart.connections, file.connections);
  const picksFile = ROOT_WF('01-us-stock-picks.json');
  assert.deepEqual(shape(workflowInN8n('smHalalPicks0001')).filter((n) => n.type.includes('langchain')), shape(picksFile).filter((n) => n.type.includes('langchain')));
  assert.equal(active().length, 5);
  console.log('\nSETUP TEST OK');
} catch (e) {
  console.error('\nSETUP TEST FAILED:', e.message);
  process.exitCode = 1;
} finally {
  // files written by the container belong to its user; remove them from inside a container
  try {
    docker(['run', '--rm', '-v', `${data}:/data`, '--entrypoint', 'sh', IMAGE, '-c', 'rm -rf /data/* /data/.[!.]* 2>/dev/null; true']);
  } catch {}
  rmSync(data, { recursive: true, force: true });
}
