#!/usr/bin/env node
// Setup that runs before every "n8n start" (Docker entrypoint and windows/start-n8n.ps1). It is safe to run each time:
//  1. Credentials: every credential the workflows use is created. A key given in an environment variable is
//     always written (the environment wins, so rotating a key = change the variable and restart). Without a
//     variable, a REPLACE_ME placeholder is created only if the credential does not exist yet.
//  2. Workflows: workflows/*.json are imported only when their id is not in n8n yet, so your edits are never
//     overwritten. YOUR_TELEGRAM_CHAT_ID is replaced by TELEGRAM_CHAT_ID, also later: a workflow that still holds
//     the placeholder gets the chat id written in, and nothing else in it changes. SM_REIMPORT_WORKFLOWS=true
//     re-imports the files over your copies. A workflow you archived in n8n is left alone.
//  3. AI: the workflow files use OpenAI. With GEMINI_API_KEY and no OPENAI_API_KEY (or AI_PROVIDER=gemini) the setup
//     switches the AI model nodes to n8n's own Google Gemini nodes, model GEMINI_MODEL (default gemini-3.1-flash-lite),
//     both in the files it imports and in the copies already in n8n; nothing else in a workflow changes.
//     AI_PROVIDER=openai switches them back. The briefs (SM-01..03) need no AI key: without one they go out without
//     their AI paragraph. The Telegram assistant (WF-11.1, WF-11.2) needs one.
//  4. Publishing (N8N_AUTO_PUBLISH=true): each of these workflows that is not published gets published as soon as
//     it can run: no REPLACE_ME key (the AI key of the briefs excepted), a chat id, an https URL for the Telegram
//     trigger, and every sub-workflow it calls published too. A key added later therefore gets its workflow
//     published on the next start. With N8N_AUTO_PUBLISH=false you publish and unpublish in the editor yourself.
// To tell a REPLACE_ME credential from a real one, the setup exports the credentials decrypted into a private temp
// folder, reads only whether each value is still REPLACE_ME, and deletes the file straight away.
// Environment: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, OPENAI_API_KEY, GEMINI_API_KEY, GEMINI_MODEL, AI_PROVIDER,
//              FMP_API_KEY, BRIEF_SECRET, CHART_IMG_API_KEY, N8N_WEBHOOK_URL, N8N_AUTO_PUBLISH, SM_REIMPORT_WORKFLOWS,
//              SM_WORKFLOWS_DIR, N8N_BIN, N8N_BIN_JS, OPENAI_BASE_URL, GEMINI_API_BASE_URL, TELEGRAM_API_BASE_URL
//              (the three *_BASE_URL only to point at another endpoint).
//   node tools/first-run-setup.mjs            (n8n must not be running, it uses the n8n CLI)
//   node tools/first-run-setup.mjs --dry-run  (prints the plan for an empty n8n, changes nothing, does not need n8n)
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_DIR = process.env.SM_WORKFLOWS_DIR || join(HERE, '..', 'workflows');
const DRY = process.argv.includes('--dry-run');
const env = (k) => String(process.env[k] || '').trim();
const yes = (k) => /^(1|true|yes)$/i.test(env(k));
const log = (m) => console.log(`[stock-market setup] ${m}`);
const PLACEHOLDER = 'REPLACE_ME';
export const CHAT_PLACEHOLDER = 'YOUR_TELEGRAM_CHAT_ID';
const TEMP_PREFIX = 'sm-setup-';

// Credential name (as used in the workflows) → environment variable and the fields n8n stores for that type.
export const CREDENTIALS_FROM_ENV = {
  'Telegram bot': { type: 'telegramApi', env: 'TELEGRAM_BOT_TOKEN', data: (v) => ({ accessToken: v, baseUrl: env('TELEGRAM_API_BASE_URL') || 'https://api.telegram.org' }) },
  // OPENAI_BASE_URL also lets you use an OpenAI-compatible provider.
  OpenAI: { type: 'openAiApi', env: 'OPENAI_API_KEY', data: (v) => ({ apiKey: v, url: env('OPENAI_BASE_URL') || 'https://api.openai.com/v1' }) },
  // Used once the AI nodes are switched to Gemini (key from Google AI Studio). n8n appends /v1beta/... to the host.
  'Google Gemini': { type: 'googlePalmApi', env: 'GEMINI_API_KEY', data: (v) => ({ host: (env('GEMINI_API_BASE_URL') || 'https://generativelanguage.googleapis.com').replace(/\/+$/, ''), apiKey: v }) },
  'FMP API key': { type: 'httpQueryAuth', env: 'FMP_API_KEY', data: (v) => ({ name: 'apikey', value: v }) },
  'Market brief secret': { type: 'httpHeaderAuth', env: 'BRIEF_SECRET', data: (v) => ({ name: 'X-Brief-Secret', value: v }) },
  'chart-img API key': { type: 'httpHeaderAuth', env: 'CHART_IMG_API_KEY', data: (v) => ({ name: 'x-api-key', value: v }) },
};

export function readWorkflows(dir = WORKFLOW_DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => ({ file, raw: readFileSync(join(dir, file), 'utf8') }))
    .map((w) => ({ ...w, json: JSON.parse(w.raw) }));
}

// What a workflow needs before it can run unattended. A credential used only by AI model sub-nodes whose chains
// carry on when the model fails (onError "continueRegularOutput", like the AI paragraph of the briefs) is optional:
// the workflow runs without it, minus that paragraph.
export function requirements(wf) {
  const nodes = wf.nodes || [];
  const byName = new Map(nodes.map((n) => [n.name, n]));
  const carriesOn = (n) => !!n && (n.onError === 'continueRegularOutput' || n.continueOnFail === true);
  const optionalModel = (n) => {
    if (!/\.lmChat/.test(n.type)) return false;
    const targets = Object.values(wf.connections?.[n.name] || {}).flat(2).filter(Boolean).map((t) => byName.get(t.node));
    return targets.length > 0 && targets.every(carriesOn);
  };
  const creds = new Map(); // id -> { id, name, type, optional }
  const calls = new Set();
  let hasTelegramTrigger = false;
  for (const n of nodes) {
    const optional = optionalModel(n);
    for (const [type, c] of Object.entries(n.credentials || {})) {
      if (!c || !c.id) continue;
      const before = creds.get(c.id); // needed anywhere = needed
      creds.set(c.id, { id: c.id, name: c.name, type, optional: optional && (!before || before.optional) });
    }
    if (n.type === 'n8n-nodes-base.executeWorkflow' || n.type === '@n8n/n8n-nodes-langchain.toolWorkflow') {
      const id = n.parameters?.workflowId?.value ?? n.parameters?.workflowId;
      if (typeof id === 'string' && id) calls.add(id);
    }
    if (n.type === 'n8n-nodes-base.telegramTrigger') hasTelegramTrigger = true;
  }
  return { creds: [...creds.values()], calls: [...calls], hasTelegramTrigger };
}

// A Telegram chat id: a number (negative for groups and channels) or @channelname.
export const validChatId = (v) => /^-?\d{3,}$/.test(v) || /^@[A-Za-z][A-Za-z0-9_]{4,}$/.test(v);

export const withChatId = (raw, chatId) => (chatId ? raw.split(CHAT_PLACEHOLDER).join(JSON.stringify(chatId).slice(1, -1)) : raw);

// ---- AI provider ----
export const OPENAI_MODEL = 'gpt-4o-mini'; // what the workflow files use
// On Google's free tier (ai.google.dev/gemini-api/docs/pricing, June 2026); gemini-2.5-flash-lite works too.
export const GEMINI_DEFAULT_MODEL = 'gemini-3.1-flash-lite';
const LC = '@n8n/n8n-nodes-langchain.';
const AI_TYPES = {
  openai: { chat: `${LC}lmChatOpenAi`, vision: `${LC}openAi` },
  gemini: { chat: `${LC}lmChatGoogleGemini`, vision: `${LC}googleGemini` },
};
const GEMINI_CREDENTIALS = { googlePalmApi: { id: 'smCredGemini0001', name: 'Google Gemini' } };
// The node names in the files, and what they are called once switched to Gemini.
const AI_NAMES = [
  ['OpenAI model', 'Gemini model'],
  ['OpenAI Chat Model', 'Gemini Chat Model'],
  ['OpenAI', 'Gemini'],
];
// How the node after the chart analysis reads the answer of each provider's image node.
const AI_ANSWER = {
  openai: (node) => `$('${node}').item.json.choices[0].message.content`,
  gemini: (node) => `(($('${node}').item.json.content || {}).parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('')`,
};

// Which AI the workflows use. AI_PROVIDER (openai or gemini) decides; without it, Gemini when GEMINI_API_KEY is set
// and OPENAI_API_KEY is not, otherwise OpenAI (as in the files).
export function aiChoice(get = env) {
  const notes = [];
  let provider = get('AI_PROVIDER').toLowerCase();
  if (provider === 'google') provider = 'gemini';
  if (provider && provider !== 'openai' && provider !== 'gemini') {
    notes.push(`AI_PROVIDER "${get('AI_PROVIDER')}" is not openai or gemini, ignored`);
    provider = '';
  }
  const forced = !!provider;
  if (!provider) provider = get('GEMINI_API_KEY') && !get('OPENAI_API_KEY') ? 'gemini' : 'openai';
  const asked = get('GEMINI_MODEL').replace(/^models\//, '');
  const modelExplicit = /^[a-z0-9][a-z0-9.-]*$/i.test(asked);
  if (asked && !modelExplicit) notes.push(`GEMINI_MODEL "${get('GEMINI_MODEL')}" is not a model id such as ${GEMINI_DEFAULT_MODEL}, ignored`);
  return { provider, forced, model: modelExplicit ? asked : GEMINI_DEFAULT_MODEL, modelExplicit, notes };
}

const isOpenAiNode = (n) => n.type === AI_TYPES.openai.chat || (n.type === AI_TYPES.openai.vision && n.parameters?.resource === 'image' && n.parameters?.operation === 'analyze');
const mapStrings = (v, f) =>
  typeof v === 'string' ? f(v) : Array.isArray(v) ? v.map((x) => mapStrings(x, f)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, f)])) : v;
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
// Google asks to leave Gemini 3 and later at their default temperature (ai.google.dev/gemini-api/docs/gemini-3:
// lower values "may lead to unexpected behavior, such as looping"); older models keep the file's temperature.
// No token cap: on thinking models the cap also counts the thinking.
const geminiChatOptions = (model, fileOptions = {}) => (/^gemini-[12][.-]/.test(model) && typeof fileOptions.temperature === 'number' ? { temperature: fileOptions.temperature } : {});
const geminiParameters = (fileNode, model) =>
  fileNode.type === AI_TYPES.openai.chat
    ? { modelName: `models/${model}`, options: geminiChatOptions(model, fileNode.parameters?.options) }
    : { resource: 'image', operation: 'analyze', modelId: { __rl: true, mode: 'id', value: `models/${model}` }, text: fileNode.parameters?.text ?? '', inputType: 'binary', binaryPropertyName: fileNode.parameters?.binaryPropertyName || 'data', simplify: true, options: {} };
const geminiModelOf = (n) => (n.type === AI_TYPES.gemini.chat ? n.parameters?.modelName : n.parameters?.modelId?.value);

function renameNode(wf, from, to) {
  const q = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ref = new RegExp(`(\\$\\(\\s*|\\$node\\[\\s*|\\$items\\(\\s*)(['"])${q}\\2`, 'g');
  for (const n of wf.nodes) {
    if (n.name === from) n.name = to;
    n.parameters = mapStrings(n.parameters, (s) => s.replace(ref, (m, call, quote) => `${call}${quote}${to}${quote}`));
  }
  wf.connections = Object.fromEntries(
    Object.entries(wf.connections || {}).map(([src, byType]) => [
      src === from ? to : src,
      Object.fromEntries(Object.entries(byType || {}).map(([type, outs]) => [type, (outs || []).map((list) => (list || []).map((t) => (t && t.node === from ? { ...t, node: to } : t)))])),
    ]),
  );
  if (wf.pinData && from in wf.pinData) {
    wf.pinData[to] = wf.pinData[from];
    delete wf.pinData[from];
  }
}

// The workflow (raw JSON) with its AI model nodes set to ai.provider. Only the nodes that are AI model nodes in the
// workflow file (fileWf, matched by node id) are touched, so AI nodes you add yourself stay as they are. Switching to
// Gemini derives the Gemini node from the file's OpenAI node; switching back restores the file's node. A node already
// on the right provider is left alone, except that an explicit GEMINI_MODEL sets its model. Returns raw unchanged
// (the same string) when nothing changes.
export function withAiProvider(raw, ai, fileWf) {
  if (!ai) return raw;
  const fileNodes = new Map((fileWf?.nodes || []).filter(isOpenAiNode).map((n) => [n.id, n]));
  if (!fileNodes.size) return raw;
  const wf = JSON.parse(raw);
  const to = ai.provider;
  let changed = false;
  for (const node of wf.nodes || []) {
    const file = fileNodes.get(node.id);
    if (!file) continue;
    const kind = file.type === AI_TYPES.openai.chat ? 'chat' : 'vision';
    const from = node.type === AI_TYPES.openai[kind] ? 'openai' : node.type === AI_TYPES.gemini[kind] ? 'gemini' : null;
    if (!from) continue; // replaced by something else: not ours to change
    if (from === to) {
      const model = `models/${ai.model}`;
      if (to === 'gemini' && ai.modelExplicit && geminiModelOf(node) !== model) {
        node.parameters = { ...node.parameters, ...(kind === 'chat' ? { modelName: model, options: geminiChatOptions(ai.model, file.parameters?.options) } : { modelId: { __rl: true, mode: 'id', value: model } }) };
        changed = true;
      }
      continue;
    }
    const target = to === 'openai' ? { type: file.type, typeVersion: file.typeVersion, parameters: clone(file.parameters), credentials: clone(file.credentials) } : { type: AI_TYPES.gemini[kind], typeVersion: 1.2, parameters: geminiParameters(file, ai.model), credentials: clone(GEMINI_CREDENTIALS) };
    const pair = AI_NAMES.find(([openaiName]) => openaiName === file.name);
    const wanted = pair && node.name === pair[from === 'openai' ? 0 : 1] ? pair[to === 'openai' ? 0 : 1] : node.name;
    const newName = wf.nodes.some((n) => n !== node && n.name === wanted) ? node.name : wanted;
    const oldName = node.name;
    Object.assign(node, target);
    if (kind === 'vision') for (const n of wf.nodes) n.parameters = mapStrings(n.parameters, (s) => s.split(AI_ANSWER[from](oldName)).join(AI_ANSWER[to](newName)));
    if (newName !== oldName) renameNode(wf, oldName, newName);
    changed = true;
  }
  return changed ? JSON.stringify(wf) : raw;
}

export const aiLabel = (ai) => (ai.provider === 'gemini' ? `Google Gemini (${ai.model})` : `OpenAI (${OPENAI_MODEL})`);

export const IMPORTED = new Set(['new', 'reimport', 'chat-id', 'ai-model']);

// What to do with each workflow file, given what n8n already has: existing = id -> { raw, active, archived }.
//   new       not in n8n: import the file
//   reimport  SM_REIMPORT_WORKFLOWS=true: import the file over the copy in n8n
//   chat-id   the copy in n8n still has YOUR_TELEGRAM_CHAT_ID and TELEGRAM_CHAT_ID is set: import that copy with the id
//   ai-model  the AI model nodes of the copy in n8n are on the other provider (or another GEMINI_MODEL): import that
//             copy with only those nodes changed
//   keep      leave the copy in n8n as it is
//   archived  archived in n8n: leave it alone
// raw is the workflow as it will be in n8n afterwards; activeAfter says whether it is still published (n8n
// unpublishes whatever it imports); aiChanged says whether the AI nodes of a copy in n8n were switched.
export function planWorkflows(repo, existing, { chatId = '', force = false, ai = null } = {}) {
  return repo.map((w) => {
    const id = w.json.id;
    const cur = existing.get(id);
    const item = (action, raw, activeBefore, aiChanged = false) => ({ id, name: w.json.name, file: w.file, action, raw, activeBefore, activeAfter: IMPORTED.has(action) ? false : activeBefore, aiChanged });
    const fromFile = () => withAiProvider(withChatId(w.raw, chatId), ai, w.json);
    if (!cur) return item('new', fromFile(), false);
    if (cur.archived) return item('archived', cur.raw, cur.active);
    if (force) return item('reimport', fromFile(), cur.active);
    const withId = chatId && cur.raw.includes(CHAT_PLACEHOLDER) ? withChatId(cur.raw, chatId) : cur.raw;
    const after = withAiProvider(withId, ai, w.json);
    if (after === cur.raw) return item('keep', cur.raw, cur.active);
    return item(withId !== cur.raw ? 'chat-id' : 'ai-model', after, cur.active, after !== withId);
  });
}

// The optional keys a workflow is still missing: it runs, without the part that needs them.
export const missingOptional = (raw, credentialIsReal) => requirements(JSON.parse(raw)).creds.filter((c) => c.optional && !credentialIsReal(c)).map((c) => c.name);

// Why each workflow cannot be published yet (id -> [] when it can). published = ids published in n8n right now.
export function publishPlan(items, { credentialIsReal, webhookUrl = '', published = new Set() }) {
  const info = new Map(items.filter((i) => i.action !== 'archived').map((i) => [i.id, { name: i.name, raw: i.raw, ...requirements(JSON.parse(i.raw)) }]));
  const reasons = new Map();
  for (const [id, r] of info) {
    const why = [];
    const missing = r.creds.filter((c) => !c.optional && !credentialIsReal(c)).map((c) => c.name);
    if (missing.length) why.push(`missing key: ${missing.join(', ')}`);
    if (r.raw.includes(CHAT_PLACEHOLDER)) why.push('TELEGRAM_CHAT_ID not set');
    if (r.hasTelegramTrigger && !/^https:\/\//i.test(webhookUrl)) why.push('Telegram Trigger needs N8N_WEBHOOK_URL=https://…');
    reasons.set(id, why);
  }
  // A workflow that calls one which is neither published nor publishable has to wait for it.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, r] of info) {
      if (reasons.get(id).length) continue;
      const blocked = r.calls.filter((c) => !published.has(c) && (!info.has(c) || reasons.get(c).length));
      if (blocked.length) {
        reasons.get(id).push(`calls an unpublished workflow (${blocked.map((c) => info.get(c)?.name || c).join(', ')})`);
        changed = true;
      }
    }
  }
  return reasons;
}

// The unpublished workflows that can be published, sub-workflows before the workflows that call them.
export function publishOrder(items, reasons, published = new Set()) {
  const pending = items.filter((i) => i.action !== 'archived' && !i.activeAfter && reasons.get(i.id)?.length === 0);
  const calls = new Map(pending.map((i) => [i.id, requirements(JSON.parse(i.raw)).calls]));
  const done = new Set(published);
  const order = [];
  while (pending.length) {
    const k = pending.findIndex((i) => calls.get(i.id).every((c) => done.has(c) || !pending.some((p) => p.id === c)));
    const next = pending.splice(k === -1 ? 0 : k, 1)[0]; // k === -1 only for a call cycle
    order.push(next);
    done.add(next.id);
  }
  return order;
}

function n8n(args, { capture = true } = {}) {
  const win = process.platform === 'win32';
  // N8N_BIN_JS = n8n's own entry script (node_modules/n8n/bin/n8n). windows/start-n8n.ps1 sets it so the CLI runs
  // with this same Node and no cmd.exe in between (no quoting problems with spaces in the Windows user name).
  const binJs = env('N8N_BIN_JS');
  const bin = env('N8N_BIN') || (win ? 'n8n.cmd' : 'n8n');
  const opts = { encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', env: process.env, maxBuffer: 64 * 1024 * 1024 };
  let r;
  if (binJs) r = spawnSync(process.execPath, [binJs, ...args], opts);
  else if (win) r = spawnSync(`"${bin}"`, args.map((a) => (/[\s&()^|<>]/.test(a) ? `"${a}"` : a)), { ...opts, shell: true }); // .cmd needs cmd.exe
  else r = spawnSync(bin, args, opts);
  if (r.error) throw new Error(`could not run ${binJs || bin}: ${r.error.message}`);
  return { ok: r.status === 0, out: `${r.stdout || ''}\n${r.stderr || ''}`.replace(/\x1b\[[0-9;]*m/g, '') };
}
const tail = (text, n = 1500) => text.split(/\r?\n/).filter((l) => l.trim() && !/^\s+at /.test(l)).join('\n').slice(-n);

// Workflows in n8n now: id -> { raw, active, archived }. One export call; an empty database is not an error.
function existingWorkflows(tmp) {
  const dir = join(tmp, 'workflows-now');
  mkdirSync(dir);
  const r = n8n(['export:workflow', '--all', '--separate', `--output=${dir}`]);
  const found = new Map();
  if (!r.ok) {
    if (/No workflows found/i.test(r.out)) return found;
    throw new Error(`n8n export:workflow failed:\n${tail(r.out)}`);
  }
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    for (const w of Array.isArray(j) ? j : [j]) if (w && w.id) found.set(w.id, { raw: JSON.stringify(w), active: !!w.active, archived: !!w.isArchived });
  }
  return found;
}

// Credentials in n8n now: id -> { placeholder } (whether a value is still REPLACE_ME). The decrypted export is read
// and deleted at once; no secret is kept.
function existingCredentials(tmp) {
  const file = join(tmp, 'credentials-now.json');
  const found = new Map();
  try {
    const r = n8n(['export:credentials', '--all', '--decrypted', `--output=${file}`]);
    if (!r.ok) {
      if (/No credentials found/i.test(r.out)) return found;
      throw new Error(`n8n export:credentials failed:\n${tail(r.out, 600)}`);
    }
    for (const c of JSON.parse(readFileSync(file, 'utf8'))) found.set(c.id, { placeholder: Object.values(c.data || {}).some((v) => v === PLACEHOLDER) });
  } finally {
    rmSync(file, { force: true });
  }
  return found;
}

// Temp folders left by a setup that was killed half-way (they can hold a decrypted export).
function removeStaleTemp() {
  try {
    for (const d of readdirSync(tmpdir()).filter((x) => x.startsWith(TEMP_PREFIX))) {
      const p = join(tmpdir(), d);
      if (Date.now() - statSync(p).mtimeMs > 10 * 60e3) rmSync(p, { recursive: true, force: true });
    }
  } catch {}
}

// One line for the AI choice; and what to do when its key is missing.
function logAiChoice(ai) {
  ai.notes.forEach(log);
  // Without GEMINI_MODEL the model is only a default: Gemini nodes already in n8n keep theirs.
  const model = ai.provider === 'gemini' ? (ai.modelExplicit ? `model ${ai.model} (GEMINI_MODEL)` : `default model ${ai.model} (GEMINI_MODEL picks another)`) : `model ${OPENAI_MODEL}`;
  log(`AI: ${ai.provider === 'gemini' ? 'Google Gemini' : 'OpenAI'}, ${model}`);
}
const logNoAiKey = (ai) => {
  const which = ai.provider === 'gemini' ? 'GEMINI_API_KEY' : ai.forced ? 'OPENAI_API_KEY (AI_PROVIDER=openai)' : 'GEMINI_API_KEY (Google AI Studio) or OPENAI_API_KEY';
  log(`no AI key yet: the briefs go out without their AI paragraph and the Telegram assistant waits; set ${which}`);
};

function main() {
  const ai = aiChoice();
  const repo = readWorkflows();
  // The credentials the workflows need once their AI nodes are on ai.provider.
  const needed = new Map();
  repo.forEach((w) => requirements(JSON.parse(withAiProvider(w.raw, ai, w.json))).creds.forEach((c) => needed.set(c.id, needed.has(c.id) && !needed.get(c.id).optional ? needed.get(c.id) : c)));
  for (const c of needed.values()) {
    const spec = CREDENTIALS_FROM_ENV[c.name];
    if (!spec || spec.type !== c.type) throw new Error(`No environment mapping for credential "${c.name}" (${c.type})`);
  }
  const aiCredential = [...needed.values()].find((c) => c.name === (ai.provider === 'gemini' ? 'Google Gemini' : 'OpenAI'));
  let chatId = env('TELEGRAM_CHAT_ID');
  if (chatId && !validChatId(chatId)) {
    log(`TELEGRAM_CHAT_ID "${chatId}" is not a chat id (a number such as 123456789 or -100123456789, or @channelname), ignored`);
    chatId = '';
  }
  const webhookUrl = env('N8N_WEBHOOK_URL') || env('WEBHOOK_URL');
  const fromEnv = (c) => !!(CREDENTIALS_FROM_ENV[c.name] && env(CREDENTIALS_FROM_ENV[c.name].env));
  const withoutAi = (raw, isReal) => {
    const missing = missingOptional(raw, isReal);
    return missing.length ? ` (no AI paragraph yet: no ${missing.join(', ')} key)` : '';
  };

  logAiChoice(ai);
  if (DRY) {
    if (aiCredential && !fromEnv(aiCredential)) logNoAiKey(ai);
    const items = planWorkflows(repo, new Map(), { chatId, ai });
    const reasons = publishPlan(items, { credentialIsReal: fromEnv, webhookUrl });
    for (const c of needed.values()) log(`credential "${c.name}": ${fromEnv(c) ? 'from ' + CREDENTIALS_FROM_ENV[c.name].env : `${PLACEHOLDER} unless it exists`}`);
    for (const i of items) log(`workflow "${i.name}": ${reasons.get(i.id).length ? 'not published (' + reasons.get(i.id).join('; ') + ')' : yes('N8N_AUTO_PUBLISH') ? 'published' + withoutAi(i.raw, fromEnv) : 'imported (N8N_AUTO_PUBLISH is not true)'}`);
    return;
  }

  removeStaleTemp();
  const tmp = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  try {
    // ---- what n8n has now ----
    const existing = existingWorkflows(tmp);
    const credsNow = existingCredentials(tmp);

    // ---- credentials ----
    const toImport = [];
    for (const c of needed.values()) {
      const spec = CREDENTIALS_FROM_ENV[c.name];
      const value = env(spec.env);
      const has = credsNow.has(c.id);
      if (value) toImport.push({ id: c.id, name: c.name, type: c.type, data: spec.data(value) });
      else if (!has) toImport.push({ id: c.id, name: c.name, type: c.type, data: spec.data(PLACEHOLDER) });
      const kept = has && credsNow.get(c.id).placeholder ? `still ${PLACEHOLDER}: set ${spec.env} or fill it in n8n → Credentials` : 'kept as it is in n8n';
      log(`credential "${c.name}": ${value ? `set from ${spec.env}` : has ? kept : `created with ${PLACEHOLDER}, set ${spec.env} or fill it in n8n → Credentials`}`);
    }
    if (toImport.length) {
      const credFile = join(tmp, 'credentials.json');
      writeFileSync(credFile, JSON.stringify(toImport), { mode: 0o600 });
      const r = n8n(['import:credentials', `--input=${credFile}`]);
      rmSync(credFile, { force: true });
      if (!r.ok) throw new Error(`n8n import:credentials failed:\n${tail(r.out, 600)}`);
    }
    const isReal = (c) => {
      if (fromEnv(c)) return true;
      if (toImport.some((t) => t.id === c.id)) return false; // just created as REPLACE_ME
      return credsNow.has(c.id) && !credsNow.get(c.id).placeholder;
    };
    if (aiCredential && !isReal(aiCredential)) logNoAiKey(ai);

    // ---- workflows ----
    const items = planWorkflows(repo, existing, { chatId, force: yes('SM_REIMPORT_WORKFLOWS'), ai });
    const imports = items.filter((i) => IMPORTED.has(i.action));
    for (const i of imports.filter((x) => x.activeBefore)) {
      // n8n refuses to import over a published workflow ("You do not have permission to deactivate this workflow").
      const r = n8n(['unpublish:workflow', `--id=${i.id}`]);
      if (!r.ok) throw new Error(`n8n unpublish:workflow failed for "${i.name}":\n${tail(r.out, 600)}`);
    }
    if (imports.length) {
      const dir = join(tmp, 'import');
      mkdirSync(dir);
      imports.forEach((i) => writeFileSync(join(dir, `${i.id}.json`), i.raw));
      const r = n8n(['import:workflow', '--separate', `--input=${dir}`]);
      if (!r.ok) throw new Error(`n8n import:workflow failed:\n${tail(r.out)}`);
      const names = (action) => imports.filter((i) => i.action === action).map((i) => i.name);
      if (names('new').length) log(`imported ${names('new').length} workflow(s): ${names('new').join(' | ')}`);
      if (names('reimport').length) log(`re-imported over the copies in n8n (SM_REIMPORT_WORKFLOWS=true): ${names('reimport').join(' | ')}`);
      if (names('chat-id').length) log(`wrote TELEGRAM_CHAT_ID into: ${names('chat-id').join(' | ')}`);
      const switched = imports.filter((i) => i.aiChanged).map((i) => i.name);
      if (switched.length) log(`AI nodes set to ${aiLabel(ai)} in the copies in n8n: ${switched.join(' | ')}`);
    } else {
      log('all workflows already in n8n, nothing imported (your edits are kept)');
    }
    for (const i of items.filter((x) => x.action === 'archived')) log(`"${i.name}" is archived in n8n, left alone`);

    // ---- publish ----
    const unpublished = items.filter((i) => i.action !== 'archived' && !i.activeAfter);
    if (!yes('N8N_AUTO_PUBLISH')) {
      if (unpublished.length) log(`N8N_AUTO_PUBLISH is not true; publish these in the n8n editor when they are ready: ${unpublished.map((i) => i.name).join(' | ')}`);
      return;
    }
    const published = new Set([...existing].filter(([, w]) => w.active).map(([id]) => id));
    imports.forEach((i) => published.delete(i.id));
    const reasons = publishPlan(items, { credentialIsReal: isReal, webhookUrl, published });
    for (const i of unpublished) if (reasons.get(i.id).length) log(`not published "${i.name}": ${reasons.get(i.id).join('; ')}`);
    for (const i of publishOrder(items, reasons, published)) {
      const r = n8n(['publish:workflow', `--id=${i.id}`]);
      log(r.ok ? `published "${i.name}"${withoutAi(i.raw, isReal)}` : `could not publish "${i.name}": ${tail(r.out, 400)}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Run only when started directly (the tests import this file). Compared through realpath, case-blind on Windows,
// so "c:\users\..." and "C:\Users\..." count as the same file.
function startedDirectly() {
  try {
    const [a, b] = [process.argv[1] || '', fileURLToPath(import.meta.url)].map((p) => realpathSync(p));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

if (startedDirectly()) {
  try {
    main();
  } catch (e) {
    log(`ERROR: ${e.message}`);
    process.exit(1);
  }
}
