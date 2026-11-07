#!/usr/bin/env node
// Live check of the market data sources, with the workflows' own code and no keys:
//   SM-02 Africa brief: NGX price list, BRVM share table, BVMAC bulletin (the BOC PDF), the headlines of each market
//                       (Google News) and its X posts (a Nitter mirror)
//   SM-03 Dangote watch: the Google News search, the NGX list and the X posts
// Each request uses the URL, headers, timeout and retries of the workflow's own node, as n8n applies them: a node set to
// "Retry On Fail" is tried up to 3 times, 5 s apart, and its timeout counts the time without any data arriving (a slow
// download that keeps coming is not cut off). The BOC PDF and the Dangote news feed are read with the libraries and
// settings of n8n's "Extract from File" and "RSS Read" nodes, loaded from your n8n install. Then the workflows' Code
// nodes run on what came back, and both briefs are printed as they would be sent (without the AI text).
//
//   node tools/check-sources.mjs            on Windows: windows\check-sources.cmd
//     --n8n <folder>     n8n's package folder (default: from %LOCALAPPDATA%\n8n-sm\install.json, then the usual places)
//     --save <folder>    also save what each source returned, to look at it or to refresh tests/fixtures
//     --map <from>=<to>  fetch URLs that start with <from> from <to> instead (the tests point it at a local server)
//     --fast             retry at once instead of waiting 5 s (the tests use it)
// Exit codes: 0 every source answered and was read, 1 a source failed or could not be read, 2 bad usage or n8n not found.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const RSS_RELAXED_ACCEPT = 'application/rss+xml, application/rdf+xml;q=0.8, application/atom+xml;q=0.6, application/xml;q=0.4, text/xml;q=0.4';

class UsageError extends Error {}

function parseArgs(argv) {
  const o = { n8n: null, save: null, maps: [], help: false, fast: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new UsageError(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--fast') o.fast = true;
    else if (a === '--n8n') o.n8n = value();
    else if (a === '--save') o.save = resolve(value());
    else if (a === '--map') {
      const v = value();
      const m = /^(https?:\/\/.+?)=(https?:\/\/.+)$/.exec(v);
      if (!m) throw new UsageError(`--map wants <from>=<to> with two http(s) URLs, got "${v}"`);
      o.maps.push([m[1], m[2]]);
    } else throw new UsageError(`unknown option "${a}" (see --help)`);
  }
  return o;
}

// ---------------- n8n install and its libraries ----------------
const isN8nDir = (d) => {
  try {
    return JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')).name === 'n8n';
  } catch {
    return false;
  }
};

function findN8n(given, env = process.env) {
  if (given) {
    const d = resolve(given);
    for (const c of [d, join(d, 'n8n'), join(d, 'node_modules', 'n8n')]) if (isN8nDir(c)) return c;
    throw new UsageError(`--n8n ${given}: no n8n package there (a folder whose package.json says "name": "n8n")`);
  }
  const tried = [];
  if (env.LOCALAPPDATA) {
    // Written by windows\install-n8n.ps1: n8nJs is <app>\node_modules\n8n\bin\n8n.
    const info = join(env.LOCALAPPDATA, 'n8n-sm', 'install.json');
    tried.push(info);
    try {
      const j = JSON.parse(readFileSync(info, 'utf8').replace(/^\uFEFF/, ''));
      const d = j.n8nJs && dirname(dirname(j.n8nJs));
      if (d && isN8nDir(d)) return d;
    } catch {
      // not installed with install-n8n.ps1: look further
    }
  }
  const exeDir = dirname(process.execPath);
  const candidates = [
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'n8n-sm', 'app', 'node_modules', 'n8n'),
    '/usr/local/lib/node_modules/n8n', // the n8nio/n8n Docker image
    '/usr/lib/node_modules/n8n',
    join(exeDir, 'node_modules', 'n8n'), // npm -g on Windows with Node's folder as prefix
    join(exeDir, '..', 'lib', 'node_modules', 'n8n'), // npm -g on Linux and macOS
    env.APPDATA && join(env.APPDATA, 'npm', 'node_modules', 'n8n'), // npm -g on Windows, default prefix
  ].filter(Boolean);
  for (const c of candidates) {
    tried.push(c);
    if (isN8nDir(c)) return resolve(c);
  }
  throw new UsageError(`n8n was not found (looked in ${tried.join(', ')}). Run windows\\install-n8n.cmd first, or pass --n8n <folder>.`);
}

function loadN8nLibs(n8nDir) {
  const nodesBase = [join(n8nDir, 'node_modules', 'n8n-nodes-base'), join(n8nDir, '..', 'n8n-nodes-base')].find((d) => existsSync(join(d, 'package.json')));
  if (!nodesBase) throw new UsageError(`${n8nDir}: n8n-nodes-base is missing, reinstall n8n`);
  // Resolve every library from the file of n8n's own "Extract from File" code, so we get the same copies n8n uses
  // (realpath because pnpm, which the n8n Docker image uses, links packages from elsewhere).
  const req = createRequire(join(realpathSync(nodesBase), 'dist', 'utils', 'binary.js'));
  try {
    const rss = req('rss-parser');
    return {
      version: JSON.parse(readFileSync(join(n8nDir, 'package.json'), 'utf8')).version,
      DateTime: req('luxon').DateTime,
      RssParser: rss.default || rss,
      sanitizeXmlName: req('n8n-workflow').sanitizeXmlName || ((s) => s),
      pdfjsUrl: pathToFileURL(req.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href,
      dommatrixUrl: pathToFileURL(req.resolve('@thednp/dommatrix')).href,
    };
  } catch (e) {
    throw new UsageError(`${n8nDir}: a library of n8n is missing (${String(e.message).split('\n')[0]}), reinstall n8n`);
  }
}

// ---------------- the workflows' nodes, run the way n8n runs them ----------------
function loadWorkflow(file) {
  return JSON.parse(readFileSync(join(ROOT, 'workflows', file), 'utf8'));
}
function nodeOf(wf, name) {
  const n = wf.nodes.find((x) => x.name === name);
  if (!n) throw new Error(`${wf.name}: no node "${name}" (was the workflow file changed?)`);
  return n;
}

// $('Node').first() / .all() over the outputs collected so far; n8n throws for a node that did not run.
const accessor = (outputs) => (name) => {
  if (!(name in outputs)) throw new Error(`Node '${name}' hasn't been executed`);
  const items = outputs[name].map((json) => ({ json }));
  return { all: () => items, first: () => items[0], last: () => items[items.length - 1] };
};

// A parameter: plain value, or an n8n expression "=…{{ js }}…" (the workflows only use simple ones).
function param(v, outputs, $json = {}) {
  if (typeof v !== 'string' || !v.startsWith('=')) return v;
  return v.slice(1).replace(/\{\{([\s\S]+?)\}\}/g, (_, expr) => {
    const out = new Function('$', '$json', `return (${expr});`)(accessor(outputs), $json);
    return out === null || out === undefined ? '' : String(out);
  });
}

// Set node (v3, manual mapping).
function setNode(wf, name, input, outputs) {
  const p = nodeOf(wf, name).parameters;
  const out = p.includeOtherFields ? { ...input } : {};
  for (const a of p.assignments?.assignments || []) {
    let v = param(a.value, outputs, input);
    if (a.type === 'number') v = Number(v);
    else if (a.type === 'boolean') v = v === true || v === 'true';
    out[a.name] = v;
  }
  return out;
}

// Code node, "Run Once for All Items": an async function body with $, $input, $now (Luxon) and
// $getWorkflowStaticData in scope. staticData is the workflow's own memory (the X mirror that answered, the closes of
// the last sessions); a live check starts without it, like a first run, and does not touch what n8n remembers.
async function codeNode(wf, name, outputs, input, $now, staticData = {}) {
  const n = nodeOf(wf, name);
  if (n.type !== 'n8n-nodes-base.code') throw new Error(`${wf.name}: "${name}" is not a Code node`);
  if ((n.parameters.mode || 'runOnceForAllItems') !== 'runOnceForAllItems') throw new Error(`${wf.name}: "${name}" does not run once for all items`);
  const items = input.map((json) => ({ json }));
  const $input = { all: () => items, first: () => items[0], last: () => items[items.length - 1] };
  const out = await new AsyncFunction('$', '$input', '$now', '$getWorkflowStaticData', n.parameters.jsCode)(accessor(outputs), $input, $now, () => staticData);
  return JSON.parse(JSON.stringify(out)).map((i) => i.json);
}

// "Retry On Fail" as n8n applies it (n8n-core workflow-execute.js, getRetryParams): 2 to 5 tries, at most 5 s apart.
// A node set to continue on fail is tried again when its first item came back with an error.
const retriesOf = (n) => (n.retryOnFail === true ? [Math.min(5, Math.max(2, n.maxTries || 3)), Math.min(5000, Math.max(0, n.waitBetweenTries || 1000))] : [1, 0]);
async function withRetries(n, o, attempt) {
  const [tries, wait] = retriesOf(n);
  let r;
  for (let i = 0; i < tries; i++) {
    if (i) await new Promise((done) => setTimeout(done, o.fast ? 0 : wait));
    r = await attempt();
    if (!r.failed) return r;
  }
  if (tries > 1) r.failed = `${r.failed} (tried ${tries} times)`;
  return r;
}

function mapUrl(url, maps) {
  for (const [from, to] of maps) if (url.startsWith(from)) return to + url.slice(from.length);
  return url;
}

// The timeout counts the time without any data, like n8n's (axios gives the socket that timeout): a slow download
// that keeps coming is not cut off, a site that stops answering is.
async function get(url, { headers, timeout, maps }) {
  const ac = new AbortController();
  let timer;
  const wait = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ac.abort(), timeout);
  };
  wait();
  try {
    const res = await fetch(mapUrl(url, maps), { headers, signal: ac.signal, redirect: 'follow' });
    const chunks = [];
    wait();
    if (res.body) {
      for await (const chunk of res.body) {
        chunks.push(chunk);
        wait();
      }
    }
    const body = Buffer.concat(chunks);
    if (!res.ok) {
      const snippet = body.toString('utf8').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
      throw new Error(`${res.status} ${res.statusText}${snippet ? ` - ${snippet}` : ''}`);
    }
    return { body, type: res.headers.get('content-type') || '' };
  } catch (e) {
    if (ac.signal.aborted) throw new Error(`no answer for ${timeout / 1000} s`);
    const cause = e.cause && (e.cause.code || e.cause.message);
    throw new Error(cause ? `${e.message} (${cause})` : e.message);
  } finally {
    clearTimeout(timer);
  }
}

function asText(res) {
  const charset = (/charset=([^;]+)/i.exec(res.type)?.[1] || 'utf-8').trim().replace(/^["']|["']$/g, '');
  try {
    return new TextDecoder(charset).decode(res.body);
  } catch {
    return new TextDecoder('utf-8').decode(res.body);
  }
}

// HTTP Request node (v4) with "On Error: Continue" and the node's retries: a failed request becomes an item with an error.
async function httpNode(wf, name, outputs, input, o) {
  const n = nodeOf(wf, name);
  const p = n.parameters;
  const fmt = p.options?.response?.response || {};
  const r = await withRetries(n, o, async () => {
    try {
      const url = param(p.url, outputs, input);
      if (!url) throw new Error('no URL to fetch');
      const headers = Object.fromEntries((p.sendHeaders ? p.headerParameters?.parameters || [] : []).map((h) => [h.name, param(h.value, outputs, input)]));
      const res = await get(url, { headers, timeout: p.options?.timeout || 300000, maps: o.maps });
      if (fmt.responseFormat === 'file') return { json: {}, file: res.body };
      const text = asText(res);
      return { json: { [fmt.outputPropertyName || 'data']: text }, text };
    } catch (e) {
      return { failed: e.message };
    }
  });
  return r.failed ? { json: { error: { message: r.failed } } } : r;
}

// The same node for several items, in order. With "Batching" (Fetch X posts: one search a second) it waits between
// batches as n8n does.
async function httpItems(wf, name, outputs, inputs, o) {
  const batch = nodeOf(wf, name).parameters.options?.batching?.batch;
  const size = batch && batch.batchSize > 0 ? batch.batchSize : Infinity;
  const out = [];
  for (let i = 0; i < inputs.length; i++) {
    if (i && i % size === 0 && batch.batchInterval) await new Promise((done) => setTimeout(done, batch.batchInterval));
    out.push(await httpNode(wf, name, outputs, inputs[i], o));
  }
  return out;
}

// Extract from File, PDF: the same pdfjs call and text joining as n8n-nodes-base/dist/utils/binary.js.
async function pdfText(buffer, libs) {
  if (typeof globalThis.DOMMatrix === 'undefined') globalThis.DOMMatrix = (await import(libs.dommatrixUrl)).default;
  const { getDocument } = await import(libs.pdfjsUrl);
  const doc = await getDocument({ data: new Uint8Array(buffer), verbosity: 0 }).promise;
  const parseText = (content) => {
    let lastY;
    const text = [];
    for (const item of content.items) {
      if ('str' in item) {
        if (lastY == item.transform[5] || !lastY) text.push(item.str);
        else text.push(`\n${item.str}`);
        lastY = item.transform[5];
      }
    }
    return text.join('');
  };
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) pages.push(await (await doc.getPage(i)).getTextContent().then(parseText));
  return { numpages: doc.numPages, text: pages.join('\n\n') };
}

// RSS Read node (v1.2 asks with the relaxed Accept header): parseFeedUrl in n8n-nodes-base RssFeedRead/GenericFunctions.
async function rssNode(wf, name, outputs, input, libs, o) {
  const n = nodeOf(wf, name);
  const r = await withRetries(n, o, async () => {
    try {
      const url = param(n.parameters.url, outputs, input);
      const res = await get(url, {
        headers: { 'User-Agent': 'rss-parser', Accept: n.typeVersion >= 1.2 ? RSS_RELAXED_ACCEPT : 'application/rss+xml' },
        timeout: 60000,
        maps: o.maps,
      });
      const xml = asText(res);
      const parser = new libs.RssParser({ xml2js: { tagNameProcessors: [libs.sanitizeXmlName], attrNameProcessors: [libs.sanitizeXmlName] } });
      const feed = await parser.parseString(xml);
      return { items: feed.items || [], xml };
    } catch (e) {
      return { failed: e.message };
    }
  });
  return r.failed ? { items: [{ error: r.failed }], failed: r.failed } : r;
}

// "X feed list" → "X on?" → "Fetch X posts", the X steps of SM-02 and SM-03. "X on?" lets an item through when it has
// a URL; with X off, "Fetch X posts" does not run.
async function xSteps(wf, out, input, $now, sd, o, save) {
  out['X feed list'] = await codeNode(wf, 'X feed list', out, input, $now, sd);
  const on = out['X feed list'].filter((j) => j.url);
  if (!on.length) return out['X feed list'];
  const got = await httpItems(wf, 'Fetch X posts', out, on, o);
  got.forEach((g, i) => save(`x-${on[i].market}.xml`, g.text));
  out['Fetch X posts'] = got.map((g) => g.json);
  return out['Fetch X posts'];
}

// ---------------- report ----------------
const plain = (html) =>
  String(html || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
const pct = (x) => (x === null || x === undefined ? 'n/a' : `${x > 0 ? '+' : ''}${Number(x).toFixed(2)}%`);

const MARKETS = ['ngx', 'brvm', 'bvmac'];
const perMarket = (feeds, list) => MARKETS.map((m) => `${m.toUpperCase()} ${(feeds[m] && feeds[m][list] ? feeds[m][list] : []).length}`).join(', ');
const problemsOf = (feeds, key) => MARKETS.filter((m) => feeds[m] && feeds[m][key]).map((m) => `; ${m.toUpperCase()}: ${feeds[m][key]}`).join('');
// What X said through the mirror: off, failed (the brief goes out without X posts), or the posts found.
function xLine(x, count) {
  if (!x || x.state === 'off') return [true, `off: ${(x && x.why) || 'the X step did not run'}`];
  if (x.state === 'failed') return [false, `no answer from ${x.mirror}: ${x.error}${x.next ? ` (n8n moves on to ${x.next} at its next run)` : ''}; the brief goes out without X posts`];
  return [true, `${x.mirror}: ${count}`];
}

function watchNote(m) {
  const missing = m.watchlist.filter((r) => r.missing).map((r) => r.symbol);
  return `watchlist ${m.watchlist.length - missing.length}/${m.watchlist.length}${missing.length ? ` (not in the list: ${missing.join(', ')})` : ''}`;
}

async function main(argv) {
  let o;
  let libs;
  try {
    o = parseArgs(argv);
    if (o.help) {
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\nimport ')[0].replace(/^#!.*\n/, '').replace(/^\/\/ ?/gm, ''));
      return 0;
    }
    libs = loadN8nLibs(findN8n(o.n8n));
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`check-sources: ${e.message}`);
    return 2;
  }
  const save = (file, data) => {
    if (!o.save || data === undefined || data === null) return;
    mkdirSync(o.save, { recursive: true });
    writeFileSync(join(o.save, file), typeof data === 'string' || Buffer.isBuffer(data) ? data : `${JSON.stringify(data, null, 2)}\n`);
  };
  const $now = libs.DateTime.now().setZone('Africa/Lagos');
  const title = `Live check of the market sources with the code of SM-02 and SM-03 (libraries of n8n ${libs.version}), ${$now.toFormat('yyyy-LL-dd HH:mm')} in Lagos`;
  console.log(`${title}\n`);

  const lines = [];
  const failed = [];
  const report = (label, ok, detail) => {
    lines.push(`${label.padEnd(11)}${ok ? 'ok    ' : 'FAILED'}  ${detail}`);
    if (!ok) failed.push(label);
  };
  const briefs = [];

  // ---- SM-02 · Africa brief ----
  try {
    const wf = loadWorkflow('02-africa-markets-brief.json');
    const out = {};
    out.Config = [setNode(wf, 'Config', { source: 'schedule' }, out)];
    const ngx = await httpNode(wf, 'NGX price list', out, out.Config[0], o);
    out['NGX price list'] = [ngx.json];
    save('ngx-equities.json', ngx.text);
    const brvm = await httpNode(wf, 'BRVM price table', out, ngx.json, o);
    out['BRVM price table'] = [brvm.json];
    save('brvm-cours-actions.html', brvm.text);
    const index = await httpNode(wf, 'BVMAC bulletin index', out, brvm.json, o);
    out['BVMAC bulletin index'] = [index.json];
    save('boc-index.html', index.text);
    out['Pick latest BOC'] = await codeNode(wf, 'Pick latest BOC', out, [index.json], $now);
    const pick = out['Pick latest BOC'][0];
    let read;
    if (pick.bocUrl) {
      const pdf = await httpNode(wf, 'Download BOC PDF', out, pick, o);
      out['Download BOC PDF'] = [pdf.json];
      if (pdf.file) {
        save(pick.bocUrl.split('/').pop(), pdf.file);
        try {
          read = await pdfText(pdf.file, libs);
          save('boc.txt', read.text);
        } catch (e) {
          read = { error: { message: `PDF could not be read: ${e.message}` } };
        }
      } else read = pdf.json;
    } else read = { error: { message: 'no BOC to download' } };
    out['Read BOC text'] = [read];
    const sd = {};
    out['Headline feeds'] = await codeNode(wf, 'Headline feeds', out, [read], $now, sd);
    const news = await httpItems(wf, 'Fetch headlines', out, out['Headline feeds'], o);
    news.forEach((r, i) => save(`news-${out['Headline feeds'][i].market}.xml`, r.text));
    out['Fetch headlines'] = news.map((r) => r.json);
    const beforeBrief = await xSteps(wf, out, out['Fetch headlines'], $now, sd, o, save);
    const [d] = await codeNode(wf, 'Build Africa brief', out, beforeBrief, $now, sd);
    out['Build Africa brief'] = [d];
    save('sm02-build-africa-brief.json', d);

    const err = d.errors || {};
    if (err.ngx || !d.ngx) report('NGX', false, err.ngx || 'no data');
    else if (!d.ngx.count) report('NGX', false, 'the list came back without any share');
    else report('NGX', true, `${d.ngx.count} shares, session ${d.ngx.session}, ${watchNote(d.ngx)}`);
    if (err.brvm || !d.brvm) report('BRVM', false, err.brvm || 'no data');
    else if (!d.brvm.count) report('BRVM', false, 'no share could be read from the table (did the page layout change?)');
    else report('BRVM', true, `${d.brvm.count} shares, séance ${d.brvm.session}, ${watchNote(d.brvm)}`);
    if (err.bvmac || !d.bvmac) report('BVMAC', false, err.bvmac || 'no data');
    else {
      const v = d.bvmac;
      const idx = v.index ? `, All Share Index ${v.index.value} (${pct(v.index.changePct)})` : ', All Share Index not found';
      const fresh = v.equities.filter((e) => e.isNew).map((e) => e.ticker);
      const detail = `BOC ${v.bulletin}: ${v.equities.length} shares${idx}${fresh.length ? `; new on the list: ${fresh.join(', ')}` : ''}`;
      if (!v.equities.length) report('BVMAC', false, `${detail}; no share could be read from the PDF (did its layout change?)`);
      else if (v.unparsed.length) report('BVMAC', false, `${detail}; not read: ${v.unparsed.join(', ')} (see ${v.url})`);
      else report('BVMAC', true, detail);
    }
    const feeds = d.feeds || {};
    const hours = d.hours || { news: 72, x: 24 };
    const newsProblems = problemsOf(feeds, 'newsError');
    report('Headlines', !newsProblems, `Google News: ${perMarket(feeds, 'news')} from the last ${hours.news} h${newsProblems}`);
    report('X posts', ...xLine(d.x, `${perMarket(feeds, 'posts')} posts from the last ${hours.x} h${problemsOf(feeds, 'postsError')}`));
    const msgs = await codeNode(wf, 'Compose message', out, [{}], $now, sd);
    briefs.push(['SM-02 Africa brief, as Telegram would show it (the AI insights are left out)', msgs.map((m) => plain(m.text)).join('\n\n')]);
  } catch (e) {
    report('SM-02', false, `the workflow's code stopped: ${e.message}`);
  }

  // ---- SM-03 · Dangote watch (as when asked on demand: it looks back further than the scheduled run) ----
  try {
    const wf = loadWorkflow('03-dangote-watch.json');
    const out = {};
    out.Config = [setNode(wf, 'Config', { source: 'subworkflow' }, out)];
    const rss = await rssNode(wf, 'Google News RSS', out, out.Config[0], libs, o);
    out['Google News RSS'] = rss.items.length ? rss.items : [{}]; // the node always outputs data
    save('google-news.xml', rss.xml);
    const ngx = await httpNode(wf, 'NGX price list', out, out['Google News RSS'][0], o);
    out['NGX price list'] = [ngx.json];
    const sd = {};
    const beforeFind = await xSteps(wf, out, [ngx.json], $now, sd, o, (file, data) => save(file.replace(/^x-/, 'sm03-x-'), data));
    const [f] = await codeNode(wf, 'Find what is new', out, beforeFind, $now, sd);
    out['Find what is new'] = [f];
    save('sm03-find-what-is-new.json', f);

    const query = out.Config[0].newsQuery;
    if (f.newsError) report('News', false, `Google News "${query}": ${f.newsError}`);
    else {
      const dated = rss.items.filter((i) => i && i.title && Number.isFinite(Date.parse(i.isoDate || i.pubDate || ''))).length;
      if (rss.items.length && !dated) report('News', false, `Google News "${query}": ${rss.items.length} items, none with a title and a date`);
      else report('News', true, `Google News "${query}": ${rss.items.length} items, ${f.articles.length} from the last ${f.lookbackHours} h`);
    }
    if (f.ngxError) report('Dangote', false, `NGX: ${f.ngxError}`);
    else if (!f.shares.length) report('Dangote', false, 'no Dangote share in the NGX list');
    else {
      const fresh = f.newListings.map((s) => s.symbol);
      report('Dangote', true, `${f.shares.map((s) => `${s.symbol} ₦${s.close}`).join(', ')} (session ${f.session})${fresh.length ? `; NEW on NGX: ${fresh.join(', ')}, add it to SM-02 ngxWatchlist and SM-03 knownDangoteSymbols` : ''}`);
    }
    report('X Dangote', ...xLine(f.x, `${(f.posts || []).length} posts from the last ${f.lookbackHours} h`));
    const msgs = await codeNode(wf, 'Compose message', out, [{}], $now, sd);
    briefs.push([`SM-03 Dangote watch, as Telegram would show it on demand (the AI summary is left out)`, msgs.map((m) => plain(m.text)).join('\n\n')]);
  } catch (e) {
    report('SM-03', false, `the workflow's code stopped: ${e.message}`);
  }

  const xOnly = failed.length && failed.every((l) => l.startsWith('X '));
  const xHint = failed.some((l) => l.startsWith('X ')) ? ' X posts come from Nitter mirrors run by volunteers: if a mirror stays silent, put another one in Config → xMirrors of SM-02 and SM-03.' : '';
  const verdict = !failed.length
    ? 'All sources answered and were read.'
    : xOnly
      ? `Problem with: ${failed.join(', ')}. The market data is fine; the briefs go out without X posts until a mirror answers.${xHint}`
      : `Problem with: ${failed.join(', ')}. Run it again later in case a site was down; if it stays, the site may have changed.${xHint}`;
  const body = [...lines, ...briefs.map(([t, x]) => `\n---- ${t} ----\n${x}`), `\n${verdict}`].join('\n');
  console.log(body);
  save('check-sources.txt', `${title}\n\n${body}\n`); // everything printed above, next to what the sites returned
  if (o.save) console.log(`What the sources returned is in ${o.save}`);
  return failed.length ? 1 : 0;
}

// Exit once everything printed has been written out (a console or pipe on Windows may still be writing).
const exit = (code) => process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
main(process.argv.slice(2)).then(exit, (e) => {
  console.error(`check-sources: ${e.stack || e.message}`);
  exit(1);
});
