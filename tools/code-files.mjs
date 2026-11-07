// The Code-node sources in src/code. A line "// #include <name>" pastes src/code/<name>.js in its place, so helpers
// shared by two Code nodes (lib-feeds, lib-compose) live in one file and each n8n Code node stays self-contained.
// Used by tools/build-workflows.mjs and the tests, so both see exactly the same code.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function codeSource(root, name, seen = []) {
  if (seen.includes(name)) throw new Error(`src/code: include loop ${[...seen, name].join(' → ')}`);
  const src = readFileSync(join(root, 'src', 'code', `${name}.js`), 'utf8');
  return src.replace(/^\/\/ #include ([\w-]+)[ \t]*$/gm, (_, lib) => codeSource(root, lib, [...seen, name]).trimEnd());
}
