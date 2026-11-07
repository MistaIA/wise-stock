#!/usr/bin/env node
// Fetches n8n templates from the awesome-n8n-templates site with defuddle (the readable Markdown of each page) and the
// importable workflow.json from the same project on GitHub (the site links workflow.json but does not serve it).
//   node templates/fetch-templates.mjs                       the 7 templates this project learned from (templates/README.md)
//   node templates/fetch-templates.mjs --ids 3202,10460      these templates
//   node templates/fetch-templates.mjs --match "telegram"    every template in the category whose title matches
//   node templates/fetch-templates.mjs --all                 all of them (340 pages, slow)
// More options: --category crypto-trading   --out templates/defuddle   --force (fetch files that are already saved)
// Unstable internet: every download is tried 4 times (15 s, 1 min and 4 min apart), and files already saved are skipped,
// so running it again picks up where it stopped. Exit code 0: all saved. 1: some failed, run it again later. 2: bad use.
// defuddle (npm) is installed on first use into templates/.tools with the npm that comes with this Node, so npx is not
// needed. Keys that template authors left in their workflow.json are replaced with placeholders, and the script says so.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFUDDLE = 'defuddle@0.19.6';
export const DEFAULT_IDS = ['15928', '10460', '5712', '3202', '13981', '16524', '14580'];

export function parseArgs(argv) {
  const o = {
    site: 'https://scrapernode.github.io/awesome-n8n-templates/',
    raw: 'https://raw.githubusercontent.com/ScraperNode/awesome-n8n-templates/main/',
    category: 'crypto-trading',
    out: join(HERE, 'defuddle'),
    tools: join(HERE, '.tools'),
    delays: [15_000, 60_000, 240_000],
    ids: null,
    match: null,
    all: false,
    force: false,
    defuddle: null,
  };
  const value = (i) => {
    if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') o.all = true;
    else if (a === '--force') o.force = true;
    else if (a === '--ids') o.ids = value(i++).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--match') o.match = new RegExp(value(i++), 'i');
    else if (a === '--category') o.category = value(i++);
    else if (a === '--out') o.out = resolve(value(i++));
    else if (a === '--site') o.site = value(i++);
    else if (a === '--raw') o.raw = value(i++);
    else if (a === '--tools') o.tools = resolve(value(i++));
    else if (a === '--defuddle') o.defuddle = resolve(value(i++)); // an existing defuddle/dist/cli.js
    else if (a === '--delays') o.delays = value(i++).split(',').map(Number); // ms between tries, for tests
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`unknown option ${a}`);
  }
  if (!/^[a-z0-9-]+$/.test(o.category)) throw new Error('--category is a folder name such as crypto-trading');
  if (o.ids && !o.ids.every((id) => /^\d+$/.test(id))) throw new Error('--ids takes template numbers, e.g. 3202,10460');
  for (const k of ['site', 'raw']) if (!o[k].endsWith('/')) o[k] += '/';
  if (!o.ids && !o.match && !o.all) o.ids = DEFAULT_IDS;
  return o;
}

// Template links in the category page, as defuddle writes them (absolute URLs) or as the GitHub README has them
// (relative "1234-some-title/").
export function templateLinks(markdown, category) {
  const seen = new Map();
  const re = new RegExp(`\\[([^\\]]+)\\]\\((?:[^)\\s]*/templates/${category}/)?(\\d+)-([a-z0-9-]+)/?\\)`, 'g');
  for (const m of markdown.matchAll(re)) {
    const id = m[2];
    if (seen.has(id)) continue;
    const title = m[1].replace(/^[\s🏆🥇🥈🥉📈]+/u, '').replace(/\\([|[\]])/g, '$1').trim();
    seen.set(id, { id, slug: `${id}-${m[3]}`, title });
  }
  return [...seen.values()];
}

// Literal keys in a template's JSON (not n8n expressions or credentials) become placeholders.
export function redactKeys(raw) {
  const found = [];
  const swap = (re, label, to) => {
    raw = raw.replace(re, (...m) => {
      found.push(label);
      return typeof to === 'function' ? to(...m) : to;
    });
  };
  swap(/([?&](?:apikey|api_key|apiKey|token|access_key)=)(?!\{\{|YOUR_)([A-Za-z0-9_-]{12,})/g, 'key in a URL', (_, p) => `${p}YOUR_API_KEY`);
  // n8n query or header parameters: { "name": "apikey", "value": "abc…" } (the value may start with "=", expression mode)
  swap(/("name":\s*"(?:apikey|api_key|apiKey|api-key|x-api-key|key|token|access_token|access_key|authorization)",\s*"value":\s*")(?!=?(?:Bearer )?(?:\{\{|YOUR_))(=?(?:Bearer )?)([^"{}]{12,})(")/gi, 'key in a parameter', (_, a, pre, _v, z) => `${a}${pre}YOUR_API_KEY${z}`);
  swap(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, 'OpenAI-style key', 'YOUR_OPENAI_API_KEY');
  swap(/\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/g, 'Telegram bot token', 'YOUR_TELEGRAM_BOT_TOKEN');
  swap(/\bAIza[0-9A-Za-z_-]{30,}/g, 'Google API key', 'YOUR_GOOGLE_API_KEY');
  return { raw, found };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class HardError extends Error {}

async function withRetries(label, delays, fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof HardError || attempt > delays.length) throw e;
      const wait = delays[attempt - 1];
      console.log(`  ${label}: ${e.message.split('\n')[0]}; trying again in ${Math.round(wait / 1000)} s (${attempt + 1} of ${delays.length + 1})`);
      await sleep(wait);
    }
  }
}

function run(cmd, args, { shell = false } = {}) {
  // Through a shell (only npm.cmd on Windows needs one) the arguments must be quoted: user folders can contain spaces.
  const argv = shell ? args.map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)) : args;
  return new Promise((res) => {
    const p = spawn(shell ? `"${cmd}"` : cmd, argv, { shell, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => res({ code: -1, out, err: String(e.message) }));
    p.on('close', (code) => res({ code, out, err }));
  });
}

// npm-cli.js of the Node running this script: next to node.exe on Windows, in ../lib/node_modules on Linux and macOS.
function npmCli() {
  const dir = dirname(process.execPath);
  for (const p of [join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]) {
    if (existsSync(p)) return [process.execPath, [p]];
  }
  return process.platform === 'win32' ? ['npm.cmd', []] : ['npm', []];
}

async function ensureDefuddle(o) {
  if (o.defuddle) {
    if (!existsSync(o.defuddle)) throw new HardError(`--defuddle ${o.defuddle} does not exist`);
    return o.defuddle;
  }
  const cli = join(o.tools, 'node_modules', 'defuddle', 'dist', 'cli.js');
  if (existsSync(cli)) return cli;
  mkdirSync(o.tools, { recursive: true });
  console.log(`installing ${DEFUDDLE} into ${o.tools}`);
  const [cmd, pre] = npmCli();
  await withRetries('npm install', o.delays, async () => {
    const r = await run(cmd, [...pre, 'install', DEFUDDLE, '--prefix', o.tools, '--no-audit', '--no-fund', '--ignore-scripts', '--fetch-retries', '3'], { shell: cmd === 'npm.cmd' });
    if (r.code !== 0) {
      const text = `${r.err}\n${r.out}`;
      if (/E404|ETARGET|ENOSPC|EACCES|EPERM/.test(text)) throw new HardError(`npm install failed:\n${text.slice(-1500)}`);
      throw new Error(`npm install failed: ${text.trim().split('\n').slice(-3).join(' | ')}`);
    }
  });
  if (!existsSync(cli)) throw new HardError(`npm finished but ${cli} is missing`);
  return cli;
}

async function defuddle(cli, url, delays) {
  return withRetries(url, delays, async () => {
    const r = await run(process.execPath, [cli, 'parse', url, '--markdown', '--frontmatter']);
    if (r.code === 0 && r.out.trim()) return r.out;
    const why = (r.err || r.out || `exit code ${r.code}`).trim();
    if (/\b(404|410)\b/.test(why)) throw new HardError(`${url}: ${why}`);
    throw new Error(why);
  });
}

async function download(url, delays) {
  return withRetries(url, delays, async () => {
    let r;
    try {
      r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    } catch (e) {
      throw new Error(e.name === 'TimeoutError' ? 'no answer within 60 s' : String((e.cause && e.cause.code) || e.message));
    }
    if (r.status === 404 || r.status === 410) throw new HardError(`${url}: HTTP ${r.status}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  });
}

const save = (file, text) => {
  writeFileSync(file + '.part', text);
  renameSync(file + '.part', file); // never leave half a file that a later run would skip
};

export async function main(argv) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    console.error(`${e.message}\nSee the top of templates/fetch-templates.mjs for how to use it.`);
    return 2;
  }
  if (o.help) {
    const lines = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1);
    console.log(lines.slice(0, lines.findIndex((l) => !l.startsWith('//'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    return 0;
  }
  mkdirSync(o.out, { recursive: true });
  const failed = [];
  let cli;
  try {
    cli = await ensureDefuddle(o);
  } catch (e) {
    console.error(`could not install defuddle: ${e.message}`);
    return 1;
  }

  // 1. The category page: readable copy, and the list of templates in it.
  const categoryUrl = `${o.site}templates/${o.category}/`;
  const categoryFile = join(o.out, `${o.category}.md`);
  let list = [];
  try {
    const md = await defuddle(cli, categoryUrl, o.delays);
    save(categoryFile, md);
    list = templateLinks(md, o.category);
    console.log(`category page: ${list.length} templates → ${categoryFile}`);
  } catch (e) {
    console.log(`category page not available (${e.message.split('\n')[0]}); using the list on GitHub instead`);
  }
  if (!list.length) {
    try {
      list = templateLinks(await download(`${o.raw}templates/${o.category}/README.md`, o.delays), o.category);
      console.log(`GitHub list: ${list.length} templates`);
    } catch (e) {
      console.error(`no template list: ${e.message}`);
      return 1;
    }
  }

  // 2. The templates asked for.
  const wanted = o.all ? list : o.match ? list.filter((t) => o.match.test(t.title)) : o.ids.map((id) => list.find((t) => t.id === id) || { id, missing: true });
  for (const t of wanted.filter((t) => t.missing)) {
    console.log(`template ${t.id} is not in ${o.category}`);
    failed.push(t.id);
  }
  let saved = 0;
  let skipped = 0;
  for (const t of wanted.filter((t) => !t.missing)) {
    const page = join(o.out, `${t.slug}.md`);
    const json = join(o.out, `${t.slug}.workflow.json`);
    try {
      if (o.force || !existsSync(page)) save(page, await defuddle(cli, `${o.site}templates/${o.category}/${t.slug}/`, o.delays));
      else skipped++;
      if (o.force || !existsSync(json)) {
        const text = await download(`${o.raw}templates/${o.category}/${t.slug}/workflow.json`, o.delays);
        let wf;
        try {
          wf = JSON.parse(text);
        } catch {
          throw new Error('workflow.json is not JSON');
        }
        if (!Array.isArray(wf.nodes)) throw new Error('workflow.json has no nodes');
        const { raw, found } = redactKeys(JSON.stringify(wf, null, 2));
        if (found.length) console.log(`  ${t.id}: replaced ${found.length} key(s) the author left in it (${[...new Set(found)].join(', ')}) with YOUR_… placeholders`);
        save(json, raw);
      } else skipped++;
      saved++;
      console.log(`ok   ${t.id}  ${t.title}`);
    } catch (e) {
      failed.push(t.id);
      console.log(`FAIL ${t.id}  ${t.title}: ${e.message.split('\n')[0]}`);
    }
  }
  console.log(`\n${saved} template(s) in ${o.out}${skipped ? ` (${skipped} file(s) were already there)` : ''}${failed.length ? `; failed: ${failed.join(', ')}; run the same command again later` : ''}`);
  return failed.length ? 1 : 0;
}

// Run main() only when started as a script (the tests import this file). Node gives this module its real path, so
// compare real paths: a folder reached through a junction or typed in another case is still this script.
const samePath = (a, b) => {
  try {
    a = realpathSync(a);
    b = realpathSync(b);
  } catch {
    // compare them as given
  }
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
};
const direct = process.argv[1] && samePath(resolve(process.argv[1]), fileURLToPath(import.meta.url));
// Exit once everything printed has been written out (a console or pipe on Windows may still be writing).
if (direct) main(process.argv.slice(2)).then((code) => process.stdout.write('', () => process.exit(code)));
