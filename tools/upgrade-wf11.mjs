#!/usr/bin/env node
// Upgrades the user's WF-11.1 / WF-11.2 (Startover/N8N-Stock-Market) instead of replacing them:
// - WF-11.1: chart-img key moves to a credential, any exchange (EXCHANGE:TICKER), no hard-coded Telegram chat.
// - WF-11.2: same Telegram/OpenAI credentials as the SM workflows + 3 new tools (US stock picks, Africa brief, Dangote watch).
// Run:  node tools/upgrade-wf11.mjs   (reads src/original/*.json, writes workflows/WF-11.*.json)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => JSON.parse(readFileSync(join(ROOT, 'src', 'original', f), 'utf8'));
const uuid = (seed) => {
  const h = createHash('sha1').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const WF = { picks: 'smHalalPicks0001', africa: 'smAfricaBrief001', dangote: 'smDangoteWatch01' };
const CRED = {
  telegram: { telegramApi: { id: 'smCredTelegram01', name: 'Telegram bot' } },
  openai: { openAiApi: { id: 'smCredOpenAi0001', name: 'OpenAI' } },
  chartImg: { httpHeaderAuth: { id: 'smCredChartImg01', name: 'chart-img API key' } },
};
const byName = (wf, name) => {
  const n = wf.nodes.find((x) => x.name === name);
  if (!n) throw new Error(`Node "${name}" not found in ${wf.name}`);
  return n;
};

// ---------------- WF-11.1 ----------------
{
  const wf = read('WF_11_1__Stock_Market_Analyst.json');
  wf.name = 'WF-11.1: Stock Market Analyst';

  const edit = byName(wf, 'Edit Fields');
  const T = "String($json.query || '').trim().toUpperCase()";
  edit.parameters.assignments.assignments = [
    { id: 'ed9ad26e-9a97-49b1-8c1c-3a2dbd87aaf0', name: 'ticker', value: `={{ ${T} }}`, type: 'string' },
    { id: uuid('wf111:symbol'), name: 'symbol', value: `={{ ${T}.includes(':') ? ${T} : 'NASDAQ:' + ${T} }}`, type: 'string' },
  ];

  const http = byName(wf, 'HTTP Request');
  http.parameters.authentication = 'genericCredentialType';
  http.parameters.genericAuthType = 'httpHeaderAuth';
  http.parameters.headerParameters.parameters = http.parameters.headerParameters.parameters.filter((h) => h.name.toLowerCase() !== 'x-api-key');
  const before = http.parameters.jsonBody;
  http.parameters.jsonBody = before.replace('"symbol": "NASDAQ:{{ $json.ticker }}"', '"symbol": "{{ $json.symbol }}"');
  if (http.parameters.jsonBody === before) throw new Error('WF-11.1: symbol line not found in the chart-img body');
  http.credentials = CRED.chartImg;

  byName(wf, 'OpenAI').credentials = CRED.openai;

  // The original sent the chart to one hard-coded Telegram chat. Return the chart URL to the caller instead;
  // WF-11.2 replies in the chat that asked.
  wf.nodes = wf.nodes.filter((n) => n.name !== 'Telegram');
  delete wf.connections.Telegram;
  wf.connections.OpenAI = { main: [[{ node: 'Edit Fields1', type: 'main', index: 0 }]] };

  const out = byName(wf, 'Edit Fields1');
  out.parameters.assignments.assignments.push(
    { id: uuid('wf111:chartUrl'), name: 'chartUrl', value: "={{ $('HTTP Request').item.json.url }}", type: 'string' },
    { id: uuid('wf111:symbolOut'), name: 'symbol', value: "={{ $('Edit Fields').item.json.symbol }}", type: 'string' },
  );

  const note = byName(wf, 'Sticky Note');
  note.parameters.content =
    '## WF-11.1: Stock Market Analyst\nCalled by WF-11.2. Input `query` = ticker. Use `EXCHANGE:TICKER` for non-NASDAQ symbols, e.g. `NYSE:KO` or `NSENG:DANGCEM`.\nCredential **chart-img API key** (Header Auth, name `x-api-key`). The old key was saved in this file, so rotate it at chart-img.com.';
  note.parameters.height = 180;
  note.parameters.width = 460;
  note.position = [-300, -280];
  writeFileSync(join(ROOT, 'workflows', 'WF-11.1-stock-chart-analyst.json'), JSON.stringify(wf, null, 2));
}

// ---------------- WF-11.2 ----------------
{
  const wf = read('WF_11_2__Stock_Market_Analyst.json');
  wf.name = 'WF-11.2: Stock Market Analyst (Telegram assistant)';
  const trigger = byName(wf, 'Telegram Trigger');
  trigger.credentials = CRED.telegram;
  // Only the chat in TELEGRAM_CHAT_ID may use the bot (the setup writes the id in), so a stranger who finds it cannot
  // spend the OpenAI credit or the 250 FMP calls a day that SM-01 needs. The filter works from v1.2 on: v1.1 shows
  // "Restrict to Chat IDs" in the editor but ignores it. 1.5 is the version a new trigger gets in n8n 2.46.
  trigger.typeVersion = 1.5;
  trigger.parameters.additionalFields = { ...(trigger.parameters.additionalFields || {}), chatIds: 'YOUR_TELEGRAM_CHAT_ID' };
  const reply = byName(wf, 'Telegram');
  reply.credentials = CRED.telegram;
  // Telegram rejects a whole message when its Markdown does not parse ("can't parse entities"), which the AI's free
  // text (a stray _ or *) easily triggers, and the node defaults to legacy Markdown. So: HTML, the text escaped, and only
  // # headings and **bold** turned into <b> (never nested: Telegram refuses some nestings). Cut first (Telegram counts
  // the text without tags), so every tag closes.
  reply.parameters.text =
    "={{ String($json.output || 'Sorry, I could not answer that.').slice(0, 4000).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/^#{1,6} +\\*{0,2}([^*\\n]+?)\\*{0,2} *$/gm, '<b>$1</b>').replace(/\\*\\*([^*\\n]+)\\*\\*/g, '<b>$1</b>') }}";
  reply.parameters.additionalFields = { ...(reply.parameters.additionalFields || {}), parse_mode: 'HTML' };
  byName(wf, 'OpenAI Chat Model').credentials = CRED.openai;

  const agent = byName(wf, 'AI Agent');
  const extra = `

## Investor profile
- The user only holds shares that pass their screen, and follows African stock markets. The screen leaves out banks and other interest-based finance, insurance, alcohol, tobacco, gambling, hotels and companies with high debt.
- When they ask for stock ideas, prefer shares that pass the screen, mark them with 🌙, and say clearly when a company fails it. Never mention religion.

## More tools
- **stockPicks**: today's 1–2 highest-scoring US shares that pass the screen, with their debt, cash and interest-income checks. Use for "stock ideas", "what should I look at today".
- **africaMarkets**: the latest brief for NGX (Nigeria), BRVM (West Africa) and BVMAC (Central Africa): prices, headlines, X posts and their mood, and one 🌙 share to look at per market. Use for questions about Dangote Cement, MTN Nigeria, Sonatel, SOCAPALM, African markets.
- **dangoteWatch**: Dangote Refinery IPO news and X posts from the last 72 hours, their mood, and Dangote share prices on NGX.
These tools take 10–60 seconds. Summarise their result in plain text; keep their numbers exactly as given.
For getChart, pass EXCHANGE:TICKER when the stock is not on NASDAQ (e.g. NYSE:KO, NSENG:DANGCEM).`;
  agent.parameters.options.systemMessage = agent.parameters.options.systemMessage.replace(/\n---\s*\n?$/, '') + extra;

  const tool = (name, description, wfId, cached, position) => ({
    parameters: {
      name,
      description,
      workflowId: { __rl: true, value: wfId, mode: 'list', cachedResultName: cached },
      workflowInputs: { mappingMode: 'defineBelow', value: {}, matchingColumns: [], schema: [], attemptToConvertTypes: false, convertFieldsToString: false },
    },
    type: '@n8n/n8n-nodes-langchain.toolWorkflow',
    typeVersion: 2,
    position,
    id: uuid(`wf112:${name}`),
    name,
  });
  wf.nodes.push(
    tool('stockPicks', "Returns today's 1-2 highest-scoring US shares that pass the screen, with their debt, cash and interest-income checks. Input: any short text such as 'today'.", WF.picks, 'SM-01 · US stock picks → Telegram', [260, 80]),
    tool('africaMarkets', "Returns the latest NGX (Nigeria), BRVM (West Africa) and BVMAC (Central Africa) market brief: prices, headlines, X posts with their mood, and one share to look at per market. Input: any short text such as 'today'.", WF.africa, 'SM-02 · Africa markets brief (NGX, BRVM, BVMAC) → Telegram', [420, 80]),
    tool('dangoteWatch', "Returns Dangote Refinery IPO headlines and X posts from the last 72 hours with their mood, and Dangote share prices on NGX. Input: any short text such as 'latest'.", WF.dangote, 'SM-03 · Dangote watch (refinery IPO + Dangote shares) → Telegram', [580, 80]),
  );
  for (const name of ['stockPicks', 'africaMarkets', 'dangoteWatch']) {
    wf.connections[name] = { ai_tool: [[{ node: 'AI Agent', type: 'ai_tool', index: 0 }]] };
  }
  const note = byName(wf, 'Sticky Note');
  note.parameters.content =
    '## WF-11.2: Telegram market assistant\nNeeds a public HTTPS URL for the Telegram Trigger (N8N_WEBHOOK_URL), so run it on the Railway/Docker deployment.\nAnswers only the chat in TELEGRAM_CHAT_ID (a number; a @channel name does not work here). More chats: Telegram Trigger → Restrict to Chat IDs, comma-separated.\nTools: getChart (WF-11.1), stockPicks (SM-01), africaMarkets (SM-02), dangoteWatch (SM-03).';
  note.parameters.height = 200;
  note.parameters.width = 520;
  writeFileSync(join(ROOT, 'workflows', 'WF-11.2-telegram-market-assistant.json'), JSON.stringify(wf, null, 2));
}
console.log('Upgraded WF-11.1 and WF-11.2');
