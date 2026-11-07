#!/usr/bin/env node
// Static check of workflows/*.json against the real node definitions of an installed n8n.
//   N8N_NODE_MODULES=/path/to/node_modules node tests/validate-workflows.mjs
// (install once with: npm install --ignore-scripts n8n@<version> in any folder)
// Checks: node type exists, typeVersion is supported, every parameter name exists for that version,
// fixed "options" values are valid, credential types are accepted by the node, connections point to real nodes.
// Each workflow with AI nodes is also checked as the start-up setup writes it for Google Gemini (GEMINI_API_KEY).
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { readWorkflows, withAiProvider, GEMINI_DEFAULT_MODEL } = await import(join(ROOT, 'tools', 'first-run-setup.mjs'));
const NM = process.env.N8N_NODE_MODULES || '/home/claude/n8n-test/node_modules';
const require = createRequire(join(NM, 'noop.js'));

const PACKAGES = ['n8n-nodes-base', '@n8n/n8n-nodes-langchain'];
const types = new Map(); // full type name -> { versions: Map(version -> description) }

function register(pkgName, description, versionsMap) {
  const full = `${pkgName}.${description.name}`;
  const entry = types.get(full) || { versions: new Map() };
  if (versionsMap) {
    for (const [v, node] of Object.entries(versionsMap)) entry.versions.set(Number(v), { ...description, ...node.description });
  } else {
    const vs = Array.isArray(description.version) ? description.version : [description.version];
    vs.forEach((v) => entry.versions.set(Number(v), description));
  }
  types.set(full, entry);
}

const unloadable = new Map(); // type -> versions found by reading the source (native deps missing in this sandbox)
const unloadableDeprecated = new Map();
// The files, then their Gemini versions.
const GEMINI = { provider: 'gemini', model: GEMINI_DEFAULT_MODEL, modelExplicit: false, notes: [] };
const checks = [];
for (const w of readWorkflows(join(ROOT, 'workflows'))) checks.push({ label: w.file, wf: w.json });
for (const w of readWorkflows(join(ROOT, 'workflows'))) {
  const raw = withAiProvider(w.raw, GEMINI, w.json);
  if (raw !== w.raw) checks.push({ label: `${w.file} as Gemini`, wf: JSON.parse(raw) });
}
const wanted = new Set();
checks.forEach((c) => c.wf.nodes.forEach((n) => wanted.add(n.type)));

for (const pkg of PACKAGES) {
  const pj = require(`${pkg}/package.json`);
  const base = dirname(require.resolve(`${pkg}/package.json`));
  for (const rel of pj.n8n.nodes) {
    const shortName = rel.split('/').pop().replace('.node.js', '');
    // Only load what we need (fast, and avoids optional deps of unrelated nodes).
    const candidates = [...wanted].filter((t) => t.startsWith(pkg + '.'));
    const lc = shortName.toLowerCase();
    if (!candidates.some((t) => t.split('.').pop().toLowerCase() === lc || lc.startsWith(t.split('.').pop().toLowerCase()))) continue;
    let mod;
    try {
      mod = require(join(base, rel));
    } catch (e) {
      const src = readFileSync(join(base, rel), 'utf8');
      const versions = [...src.matchAll(/(\d+(?:\.\d+)?): new /g)].map((m) => Number(m[1]));
      const nameMatch = src.match(/name: '([A-Za-z0-9]+)'/);
      if (nameMatch) {
        unloadable.set(`${pkg}.${nameMatch[1]}`, versions);
        unloadableDeprecated.set(`${pkg}.${nameMatch[1]}`, /deprecated:\s*true/.test(src));
      }
      continue;
    }
    for (const Cls of Object.values(mod)) {
      if (typeof Cls !== 'function') continue;
      let inst;
      try {
        inst = new Cls();
      } catch (e) {
        continue;
      }
      if (!inst.description) continue;
      register(pkg, inst.description, inst.nodeVersions);
    }
  }
}

const isExpr = (v) => typeof v === 'string' && v.startsWith('=');
function propsFor(desc) {
  return desc.properties || [];
}
function checkParams(params, props, path, errors, warnings) {
  if (!params || typeof params !== 'object') return;
  for (const [key, value] of Object.entries(params)) {
    const candidates = props.filter((p) => p.name === key);
    if (candidates.length === 0) {
      errors.push(`${path}.${key}: unknown parameter`);
      continue;
    }
    // options value check (only if all candidates are fixed options)
    const optionProps = candidates.filter((p) => p.type === 'options' && Array.isArray(p.options) && !p.typeOptions?.loadOptionsMethod);
    if (optionProps.length === candidates.length && !isExpr(value)) {
      const allowed = new Set(optionProps.flatMap((p) => p.options.map((o) => o.value)));
      if (!allowed.has(value)) errors.push(`${path}.${key}: value "${value}" not in [${[...allowed].join(', ')}]`);
    }
    // A parameter name can be declared several times (one per operation/resource): merge them.
    const collections = candidates.filter((p) => p.type === 'collection');
    if (collections.length && value && typeof value === 'object') {
      checkParams(value, collections.flatMap((p) => p.options || []), `${path}.${key}`, errors, warnings);
    }
    const fixed = candidates.filter((p) => p.type === 'fixedCollection');
    if (fixed.length && value && typeof value === 'object') {
      for (const [groupName, groupVal] of Object.entries(value)) {
        const groups = fixed.flatMap((p) => (p.options || []).filter((o) => o.name === groupName));
        if (!groups.length) {
          errors.push(`${path}.${key}.${groupName}: unknown group`);
          continue;
        }
        const entries = Array.isArray(groupVal) ? groupVal : [groupVal];
        entries.forEach((e, i) => checkParams(e, groups.flatMap((g) => g.values || []), `${path}.${key}.${groupName}[${i}]`, errors, warnings));
      }
    }
  }
}

let failures = 0;
for (const { label: f, wf } of checks) {
  const errors = [];
  const warnings = [];
  const names = new Set(wf.nodes.map((n) => n.name));
  if (names.size !== wf.nodes.length) errors.push('duplicate node names');
  for (const n of wf.nodes) {
    const entry = types.get(n.type);
    if (!entry) {
      const vs = unloadable.get(n.type);
      if (vs && vs.includes(Number(n.typeVersion))) {
        if (unloadableDeprecated.get(n.type)) errors.push(`${n.name}: ${n.type} source mentions "deprecated: true", check the version`);
        warnings.push(`${n.name}: ${n.type} v${n.typeVersion} exists (checked in source; parameters not checked because the node needs native modules here)`);
      } else {
        errors.push(`${n.name}: node type ${n.type} not found`);
      }
      continue;
    }
    const desc = entry.versions.get(Number(n.typeVersion));
    if (!desc) {
      errors.push(`${n.name}: typeVersion ${n.typeVersion} not supported (has ${[...entry.versions.keys()].join(', ')})`);
      continue;
    }
    // n8n 2.x refuses to import or save workflows that use a deprecated node (N8N_DEPRECATED_NODES_BLOCK defaults to true).
    if (desc.deprecated === true) errors.push(`${n.name}: ${n.type} v${n.typeVersion} is deprecated, n8n will refuse to import it`);
    if (n.type.endsWith('.stickyNote')) continue;
    checkParams(n.parameters, propsFor(desc), n.name, errors, warnings);
    for (const credType of Object.keys(n.credentials || {})) {
      const accepted = (desc.credentials || []).map((c) => c.name);
      const generic = n.parameters?.genericAuthType === credType || (n.type.endsWith('.webhook') && credType === 'httpHeaderAuth');
      if (!accepted.includes(credType) && !generic) errors.push(`${n.name}: credential type ${credType} not accepted (accepts ${accepted.join(', ') || 'none'})`);
    }
  }
  for (const [from, outputs] of Object.entries(wf.connections)) {
    if (!names.has(from)) errors.push(`connection from unknown node ${from}`);
    for (const branches of Object.values(outputs)) for (const branch of branches) for (const c of branch) if (!names.has(c.node)) errors.push(`connection to unknown node ${c.node}`);
  }
  const status = errors.length ? 'FAIL' : 'ok';
  if (errors.length) failures++;
  console.log(`${status}  ${f}  (${wf.nodes.length} nodes)`);
  errors.forEach((e) => console.log('   ✗', e));
  warnings.forEach((e) => console.log('   !', e));
}
console.log(`Loaded ${types.size} node types from ${PACKAGES.join(', ')}`);
process.exit(failures ? 1 : 0);
