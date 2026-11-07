// Local stand-in for every outside service the workflows call, serving the test fixtures:
// NGX JSON, BRVM HTML, BVMAC index + BOC PDF, FMP, Google News RSS (one search per market and the Dangote search),
// a Nitter mirror (/nitter) and one that is down (/nitter-down), OpenAI chat completions, Google Gemini
// (generateContent, streamGenerateContent, Files API upload), chart-img, Telegram Bot API.
// Every request is recorded so the end-to-end test can check what n8n sent (e.g. the Telegram messages).
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const read = (f) => readFileSync(join(FIX, f));
const FMP = JSON.parse(read('fmp.json'));
// 1×1 PNG, standing in for the chart image chart-img stores.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
export const CHART_ANALYSIS = 'Weekly uptrend; MACD bullish crossover; support near 120, resistance near 150.';
export const CHART_ANSWER = 'Chart read: MACD bullish crossover on NVDA.';

// The JSON the Africa brief and the Dangote watch ask for (ids h1… and x1… as the mock feeds below produce them).
export const AFRICA_AI = {
  insights: ['NGX: MTNN led the screened shares.', 'BRVM: SNTS rose 3.09% on good volume.', 'BVMAC: BGFI HC +5.45%.'],
  sentiment: { h1: 1, h2: -1, h3: 1, h4: 1, h5: 0, h6: 1, x1: 1, x2: -1, x3: 1 },
  why: { ngx: 'Biggest gain among the screened shares, <on> good volume & turnover.', brvm: 'Steady rise on good volume.' },
};
export const DANGOTE_AI = { summary: 'Allotment approved; listing expected in December <check> & refunds pending.', sentiment: { h1: 1, h2: 1, x1: 1, x2: -1 } };
// The same answers for OpenAI and Gemini, picked from the prompt. Gemini wraps JSON in a ```json fence, as it often does.
const answerFor = (prompt, fenced = false) => {
  const json = (o) => (fenced ? '```json\n' + JSON.stringify(o, null, 1) + '\n```' : JSON.stringify(o));
  if (/bot-format-test/.test(prompt)) return '**NVDA** leads <today> & AAPL follows.\n### Note\nNot financial advice.';
  if (/"insights"/.test(prompt)) return json(AFRICA_AI);
  if (/"summary"/.test(prompt)) return json(DANGOTE_AI);
  return 'NVIDIA leads on growth and margins; Apple trades near its 52-week high.';
};

// Gemini generateContent body → the parts of the model's answer. The Telegram assistant asks for a chart when the
// user's last message says "chart-test" (a getChart function call, with a thought signature that Gemini 3 wants
// back), then answers from the tool's result; the chart node sends an uploaded image.
function geminiParts(req) {
  const contents = req.contents || [];
  const text = (c) => (c?.parts || []).map((p) => p.text || '').join(' ');
  const last = contents[contents.length - 1];
  const toolResult = (last?.parts || []).find((p) => p.functionResponse);
  if (toolResult) return [{ text: JSON.stringify(toolResult.functionResponse).includes('MACD bullish crossover') ? CHART_ANSWER : 'Chart missing.' }];
  const lastUser = [...contents].reverse().find((c) => c.role === 'user' && (c.parts || []).some((p) => typeof p.text === 'string'));
  if (req.tools && /chart-test/.test(text(lastUser))) return [{ functionCall: { name: 'getChart', args: { input: 'NVDA' } }, thoughtSignature: 'sig-e2e' }];
  if ((contents[0]?.parts || []).some((p) => p.fileData)) return [{ text: CHART_ANALYSIS }];
  return [{ text: answerFor([text(req.systemInstruction), ...contents.map(text)].join(' '), true) }];
}

// Google News: the Dangote search (SM-03) and one search per market (SM-02), told apart by the query.
function rss(now, q) {
  const item = (title, hoursAgo, link, source) =>
    `<item><title>${title}</title><link>${link}</link><pubDate>${new Date(now - hoursAgo * 3600e3).toUTCString()}</pubDate>${source ? `<source url="https://example.org">${source}</source>` : ''}</item>`;
  const feed = (title, items) => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${title} - Google News</title>\n${items.join('\n')}\n</channel></rss>`;
  if (/Dangote/i.test(q)) {
    return feed('"Dangote refinery IPO"', [
      item('Dangote Petroleum Refinery shares to list on NGX in December - Reuters', 2, 'https://news.google.com/rss/articles/A1?oc=5'),
      item('Dangote refinery IPO: SEC approves basis of allotment - Nairametrics', 7.5, 'https://news.google.com/rss/articles/A2?oc=5'),
      item('Investors await Dangote refinery refunds &amp; allotment - Punch Newspapers', 31, 'https://news.google.com/rss/articles/A3?oc=5'),
    ]);
  }
  if (/BRVM/.test(q)) {
    return feed('BRVM', [
      item('La BRVM termine en hausse, Sonatel progresse - Sika Finance', 5, 'https://news.google.com/rss/articles/B1?oc=5', 'Sika Finance'),
      item('BRVM : Orange CI recule apr&#232;s son dividende - Financial Afrik', 20, 'https://news.google.com/rss/articles/B2?oc=5', 'Financial Afrik'),
    ]);
  }
  if (/BVMAC/.test(q)) return feed('BVMAC', [item('BVMAC : BGFI Holding grimpe de 5% - Investir au Cameroun', 30, 'https://news.google.com/rss/articles/C1?oc=5', 'Investir au Cameroun')]);
  return feed('NGX', [
    item('Dangote Cement shares rise as NGX gains 1% | - BusinessDay', 3, 'https://news.google.com/rss/articles/N1?oc=5', 'BusinessDay'),
    item('NGX: banks drop on profit taking - Nairametrics', 5, 'https://news.google.com/rss/articles/N2?oc=5', 'Nairametrics'),
    item('Investors cheer MTN results &amp; dividend - Guardian Nigeria', 10, 'https://news.google.com/rss/articles/N3?oc=5', 'Guardian Nigeria'),
  ]);
}

// A Nitter mirror's search feed: X posts about each market, or about Dangote.
function nitter(now, q, base) {
  const post = (text, user, hoursAgo, id) =>
    `<item><title>${text}</title><dc:creator>@${user}</dc:creator><description><![CDATA[<p>${text}</p>]]></description><pubDate>${new Date(now - hoursAgo * 3600e3).toUTCString()}</pubDate><guid>${base}/${user}/status/${id}#m</guid><link>${base}/${user}/status/${id}#m</link></item>`;
  const posts = /Dangote/i.test(q)
    ? [post('Dangote refinery IPO demand surges, shares to list in December', 'oilwatcher', 1, '301'), post('RT by @fan: Dangote refinery delays refunds, investors warn of losses', 'lagosdesk', 3, '302')]
    : /BRVM/.test(q)
      ? [post('La BRVM en hausse cette semaine, Sonatel bondit', 'abidjanbourse', 3, '201')]
      : /BVMAC/.test(q)
        ? []
        : [post('NGX All-Share index climbs to a record as MTN gains', 'naijastocks', 2, '101'), post('Banks under pressure, Access drops 3% on NGX', 'lagostrader', 5, '102')];
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>Search / X</title><link>${base}</link>${posts.join('')}</channel></rss>`;
}

export function startMock(port = 8099) {
  const log = [];
  const seen = new Map(); // requests per path, for the routes that fail at first
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const body = raw.toString('utf8');
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      log.push({ at: Date.now(), method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body, size: raw.length, png: raw.subarray(0, 8).equals(PNG.subarray(0, 8)) });
      const send = (status, type, data, headers = {}) => {
        res.writeHead(status, { 'content-type': type, ...headers });
        res.end(data);
      };
      const p = url.pathname;
      seen.set(p, (seen.get(p) || 0) + 1);
      if (p === '/ngx') return send(200, 'application/json', read('ngx-equities.json'));
      // Answers 503 twice, then the list: n8n's retries (and check-sources') get it on the third try.
      if (p === '/flaky/ngx') return seen.get(p) <= 2 ? send(503, 'text/plain', 'busy') : send(200, 'application/json', read('ngx-equities.json'));
      if (p === '/brvm') return send(200, 'text/html; charset=utf-8', read('brvm-cours-actions.html'));
      if (p === '/boc-index') return send(200, 'text/html; charset=utf-8', read('boc-index.html'));
      if (p.startsWith('/wp-content/uploads/') && p.endsWith('.pdf')) return send(200, 'application/pdf', read('boc-sample-glued.pdf'));
      if (p.startsWith('/fmp/')) {
        if (url.searchParams.get('apikey') !== 'fmp-test') return send(401, 'application/json', JSON.stringify({ 'Error Message': 'Invalid API KEY.' }));
        const sym = url.searchParams.get('symbol');
        const key = { '/fmp/profile': 'profile', '/fmp/balance-sheet-statement': 'balance', '/fmp/income-statement': 'income' }[p];
        const v = FMP[sym]?.[key];
        if (v && v.error) return send(402, 'text/plain', v.error.description);
        return send(200, 'application/json', JSON.stringify(v || []));
      }
      if (p === '/rss') return send(200, 'application/rss+xml; charset=utf-8', rss(Date.now(), url.searchParams.get('q') || ''));
      if (p.startsWith('/nitter-down/')) return send(503, 'text/plain', 'mirror busy');
      if (p === '/nitter/search/rss') return send(200, 'application/rss+xml; charset=utf-8', nitter(Date.now(), url.searchParams.get('q') || '', `http://127.0.0.1:${server.address().port}/nitter`));
      if (p === '/nitter-botcheck/search/rss') return send(200, 'text/html; charset=utf-8', '<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>');
      if (p === '/openai/v1/chat/completions') {
        if (req.headers.authorization !== 'Bearer sk-test') return send(401, 'application/json', JSON.stringify({ error: { message: 'bad key' } }));
        const prompt = JSON.parse(body || '{}').messages?.map((m) => (typeof m.content === 'string' ? m.content : '')).join(' ') || '';
        const content = answerFor(prompt);
        const created = Math.floor(Date.now() / 1000);
        if (JSON.parse(body || '{}').stream) {
          // The AI Agent (WF-11.2) asks for a stream: answer in OpenAI's server-sent-events format.
          const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created, model: 'gpt-4o-mini', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
          const usage = `data: ${JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created, model: 'gpt-4o-mini', choices: [], usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 } })}\n\n`;
          return send(200, 'text/event-stream', chunk({ role: 'assistant', content: '' }) + chunk({ content }) + chunk({}, 'stop') + usage + 'data: [DONE]\n\n');
        }
        return send(200, 'application/json', JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion', created, model: 'gpt-4o-mini', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 } }));
      }
      // Google Gemini: the chat model node sends the key as x-goog-api-key, the Gemini node as ?key=.
      if (p.startsWith('/gemini/')) {
        const keyOk = req.headers['x-goog-api-key'] === 'gm-test' || url.searchParams.get('key') === 'gm-test';
        const session = p.match(/^\/gemini\/upload-session\/(\d+)$/);
        if (session) {
          // second step of the resumable upload: the file bytes; the URL itself is the authorisation
          const name = `files/e2e-${session[1]}`;
          return send(200, 'application/json', JSON.stringify({ file: { name, uri: `http://127.0.0.1:${port}/gemini/v1beta/${name}`, mimeType: 'image/png', sizeBytes: String(raw.length), state: 'ACTIVE' } }));
        }
        if (!keyOk) return send(400, 'application/json', JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }));
        if (p === '/gemini/upload/v1beta/files') return send(200, 'application/json', '{}', { 'x-goog-upload-url': `http://127.0.0.1:${port}/gemini/upload-session/${log.length}` });
        const gen = p.match(/^\/gemini\/v1beta\/models\/([^/:]+):(generateContent|streamGenerateContent)$/);
        if (gen) {
          const parts = geminiParts(JSON.parse(body || '{}'));
          const answer = { candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20, totalTokenCount: 70 }, modelVersion: gen[1] };
          if (gen[2] === 'streamGenerateContent') return send(200, 'text/event-stream', `data: ${JSON.stringify(answer)}\r\n\r\n`);
          return send(200, 'application/json', JSON.stringify(answer));
        }
      }
      if (p === '/chart-img/v2/tradingview/advanced-chart/storage') {
        if (req.headers['x-api-key'] !== 'chart-test') return send(403, 'application/json', JSON.stringify({ message: 'Invalid API key' }));
        const { symbol } = JSON.parse(body || '{}');
        return send(200, 'application/json', JSON.stringify({ url: `http://127.0.0.1:${port}/chart-img/storage/${encodeURIComponent(symbol)}.png`, size: PNG.length, expire: new Date(Date.now() + 7 * 864e5).toISOString() }));
      }
      if (p.startsWith('/chart-img/storage/')) return send(200, 'image/png', PNG);
      const tg = p.match(/^\/telegram\/bot([^/]+)\/(\w+)$/);
      if (tg) {
        const payload = body ? JSON.parse(body) : {};
        return send(200, 'application/json', JSON.stringify({ ok: true, result: { message_id: log.length, date: Math.floor(Date.now() / 1000), chat: { id: Number(payload.chat_id) || 0, type: 'private' }, text: payload.text } }));
      }
      return send(404, 'text/plain', `mock: no route for ${p}`);
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, log })));
}
