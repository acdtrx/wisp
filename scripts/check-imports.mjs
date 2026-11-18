#!/usr/bin/env node
/**
 * Verify every relative import specifier under backend/src — plus the backend's
 * Node entry scripts (backend/scripts/*.mjs) and state migrations
 * (backend/migrations/) — resolves to a real file. Run with
 * `npm run check-imports` from the repo root.
 *
 * Why this exists: the backend is plain Node ESM with no build step and no test
 * suite, so nothing validates import paths ahead of runtime. Static imports at
 * least fail loudly at boot — but a *dynamic* import only resolves when its code
 * path runs, so a stale path can sit unnoticed until a user hits that one route.
 * That is exactly how `managedBridges.js` kept importing `../../vmManager.js`
 * after the manager relocation: VLAN bridge delete 500'd, create was fine, and
 * the backend started up perfectly.
 *
 * Deliberately a dumb string scan rather than a linter: it catches specifiers
 * ESLint's import/no-unresolved cannot see, including the literals inside the
 * platform ternaries the facades use —
 *   await import(platform() === 'linux' ? './linux/x.js' : './darwin/x.js')
 * — and JSDoc `import('./x.js')` type references. False positives are possible
 * in principle (any string that merely looks like a relative module path); none
 * exist today, and a real one is worth the noise.
 *
 * Frontend is not scanned: Vite already fails the build on unresolved imports,
 * and it resolves extensionless and aliased specifiers this scan does not model.
 *
 * Module-relative data paths get the same check: all-literal
 * `resolve(__dirname, '…')` / `join(__dirname, '…')` (in files whose `__dirname`
 * is the module's own directory) and `new URL('./…', import.meta.url)`. Such a
 * target names a bundled script, a protos dir, or a config file the app creates
 * at runtime, so it passes when the target exists **or its parent directory
 * does**. That catches the wrong-directory class — a `../` too few, a fallback
 * into a directory that was never there — but not a misspelled file name in a
 * real directory.
 *
 * Facade parity: a platform facade (`lib/<module>/index.js`) binds each
 * implementation with `const impl = await import(isLinux ? './linux/x.js' :
 * './darwin/x.js')` and re-exports `impl.name`. A name one side lacks is
 * `undefined` at call time, and only on that platform. So every `impl.name` the
 * facade reads must be exported by each file its import can load: both sides of
 * the ternary, or the one side of a single-platform import. Exports are read as
 * written (`export function`, `export const`, `export { … }`); a name an
 * implementation re-exports with `export { … } from` is followed to the file
 * that defines it. An implementation that uses `export *` fails, since the scan
 * cannot see what it exports, and so does a facade that imports a platform file
 * in any other form than `const name = … await import(…)`.
 */
import { access, readdir, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

import { stripComments } from './sourceScan.mjs';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const ROOTS = ['backend/src', 'backend/scripts', 'backend/migrations'].map((dir) => path.join(REPO_ROOT, dir));
const SPECIFIER = /['"](\.\.?\/[^'"\n]*\.m?js)['"]/g;
const DIRNAME_DEFINITION = /const __dirname = dirname\(fileURLToPath\(import\.meta\.url\)\)/;
const DIRNAME_PATH = /\b(?:resolve|join)\(\s*__dirname((?:\s*,\s*'[^'\n]*')+)(\s*,[^)\n]*)?\)/g;
const META_URL_PATH = /new URL\(\s*'(\.\.?\/[^'\n]*)'\s*,\s*import\.meta\.url\s*\)/g;

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

/**
 * Module-relative data paths: `[{ index, specifier, target, dirOnly }]`. A call
 * whose trailing arguments aren't literals (`join(__dirname, '../scripts', name)`)
 * checks its literal prefix, which must then exist itself.
 */
function dataPaths(file, source) {
  const found = [];
  if (DIRNAME_DEFINITION.test(source)) {
    for (const match of source.matchAll(DIRNAME_PATH)) {
      const parts = [...match[1].matchAll(/'([^'\n]*)'/g)].map((m) => m[1]);
      found.push({
        index: match.index,
        specifier: match[0],
        target: path.resolve(path.dirname(file), ...parts),
        dirOnly: match[2] !== undefined,
      });
    }
  }
  for (const match of source.matchAll(META_URL_PATH)) {
    found.push({
      index: match.index,
      specifier: match[0],
      target: fileURLToPath(new URL(match[1], pathToFileURL(file))),
      dirOnly: false,
    });
  }
  return found;
}

async function collectSourceFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      found.push(...await collectSourceFiles(full));
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
      found.push(full);
    }
  }
  return found;
}

/** Index just past the matching `)` of the call whose `(` ends at `open`. */
function callEnd(code, open) {
  let depth = 1;
  let j = open;
  while (j < code.length && depth > 0) {
    if (code[j] === '(') depth += 1;
    else if (code[j] === ')') depth -= 1;
    j += 1;
  }
  return j;
}

/** Index of the `;` that ends the statement starting at `from` (depth 0, outside
 *  strings), or the end of the code. */
function statementEnd(code, from) {
  let depth = 0;
  for (let i = from; i < code.length; i += 1) {
    const c = code[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < code.length && code[j] !== c) j += code[j] === '\\' ? 2 : 1;
      i = j;
    } else if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) depth -= 1;
    else if (c === ';' && depth === 0) return i;
  }
  return code.length;
}

const PLATFORM_TARGET = /['"](\.\/(?:linux|darwin)\/[^'"\n]+)['"]/g;

/**
 * A facade's platform imports. `bindings`: each `const name = …` statement whose
 * `import()` calls name platform files (`./linux/…`, `./darwin/…`), with every
 * target of the whole statement. `stray`: the index of every other import of a
 * platform file (another binding form, a static import), which parity cannot
 * follow.
 */
function platformImports(code) {
  const calls = [];
  for (const m of code.matchAll(/(?<![\w$.])import\s*\(/g)) {
    const open = m.index + m[0].length;
    const targets = [...code.slice(open, callEnd(code, open) - 1).matchAll(PLATFORM_TARGET)].map((t) => t[1]);
    if (targets.length > 0) calls.push({ index: m.index, targets });
  }
  const bindings = [];
  const bound = new Set();
  for (const m of code.matchAll(/(?<![\w$.])const\s+([\w$]+)\s*=/g)) {
    const end = statementEnd(code, m.index + m[0].length);
    const inside = calls.filter((c) => c.index > m.index && c.index < end);
    if (inside.length === 0) continue;
    for (const c of inside) bound.add(c.index);
    bindings.push({ name: m[1], targets: [...new Set(inside.flatMap((c) => c.targets))] });
  }
  const stray = calls.filter((c) => !bound.has(c.index)).map((c) => c.index);
  for (const m of code.matchAll(/(?<![\w$.])(?:import|export)\b[^;'"]*?(['"])(\.\/(?:linux|darwin)\/[^'"\n]+)\1/g)) {
    if (!/^import\s*\(/.test(m[0])) stray.push(m.index);
  }
  return { bindings, stray };
}

/**
 * A module's exports: name → `{ line, from?, sourceName? }`, where `from` is the
 * file an `export { sourceName as name } from './y.js'` takes it from. Null when
 * the module uses `export * from`, whose names the scan cannot see.
 */
async function exportTable(file) {
  const source = await readFile(file, 'utf8');
  const code = stripComments(source);
  if (/(?<![\w$.])export\s*\*\s*from/.test(code)) return null;
  const table = new Map();
  const add = (name, index, extra = {}) => table.set(name, { line: lineOf(source, index), ...extra });
  for (const m of code.matchAll(/(?<![\w$.])export\s+(?:async\s+)?function\s*\*?\s*([\w$]+)/g)) add(m[1], m.index);
  for (const m of code.matchAll(/(?<![\w$.])export\s+(?:const|let|var|class)\s+([\w$]+)/g)) add(m[1], m.index);
  for (const m of code.matchAll(/(?<![\w$.])export\s*\*\s*as\s+([\w$]+)/g)) add(m[1], m.index);
  for (const m of code.matchAll(/(?<![\w$.])export\s+default\b/g)) add('default', m.index);
  for (const m of code.matchAll(/(?<![\w$.])export\s*\{([^}]*)\}(?:\s*from\s*(['"])([^'"\n]+)\2)?/g)) {
    const from = m[3]?.startsWith('.') ? fileURLToPath(new URL(m[3], pathToFileURL(file))) : null;
    for (const part of m[1].split(',')) {
      const [sourceName, alias] = part.trim().split(/\s+as\s+/).map((x) => x.trim());
      if (!sourceName) continue;
      add(alias ?? sourceName, m.index, from ? { from, sourceName } : {});
    }
  }
  return table;
}

const rel = (abs) => path.relative(REPO_ROOT, abs);

/**
 * Whether `file` really exports `name`, following `export … from` to the file
 * that defines it: null when it does, `{ missing: true }` when `file` has no such
 * export, or the problem one step down the chain (a re-export of a name its
 * source lacks, an `export *`).
 */
async function traceExport(tables, file, name, seen = new Set()) {
  const key = `${file}#${name}`;
  if (seen.has(key) || !await exists(file)) return null; // a loop, or a missing file the specifier scan reports
  seen.add(key);
  if (!tables.has(file)) tables.set(file, await exportTable(file));
  const table = tables.get(file);
  if (table === null) {
    return { file, line: 1, message: 'uses `export *`: facade parity cannot see what it exports (list the names)' };
  }
  const entry = table.get(name);
  if (!entry) return { missing: true };
  if (!entry.from) return null;
  const found = await traceExport(tables, entry.from, entry.sourceName, seen);
  if (found?.missing) {
    return {
      file,
      line: entry.line,
      message: `re-exports \`${name}\` from ${rel(entry.from)}, which does not export \`${entry.sourceName}\``,
    };
  }
  return found;
}

/** Facade parity violations: `[{ file, line, message }]`. */
async function facadeParity(files) {
  const problems = new Map();
  const report = (p) => problems.set(`${p.file}:${p.line}:${p.message}`, p);
  const tables = new Map();
  let pairs = 0;
  const facades = files.filter((f) => /\/backend\/src\/lib\/[^/]+\/index\.js$/.test(f));
  for (const facade of facades) {
    const source = await readFile(facade, 'utf8');
    const code = stripComments(source);
    const { bindings, stray } = platformImports(code);
    for (const index of stray) {
      report({
        file: facade,
        line: lineOf(source, index),
        message: 'imports a platform file in a form facade parity cannot follow: bind it as `const name = await import(…)`',
      });
    }
    for (const { name, targets } of bindings) {
      const uses = new Map();
      for (const m of code.matchAll(new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}\\.([\\w$]+)`, 'g'))) {
        if (!uses.has(m[1])) uses.set(m[1], m.index);
      }
      for (const target of targets) {
        pairs += 1;
        const implFile = fileURLToPath(new URL(target, pathToFileURL(facade)));
        if (!await exists(implFile)) continue; // reported by the specifier scan
        if (!tables.has(implFile)) tables.set(implFile, await exportTable(implFile));
        const table = tables.get(implFile);
        // Every re-export of the implementation names something its source exports.
        for (const [exported, entry] of table ?? []) {
          if (!entry.from) continue;
          const found = await traceExport(tables, implFile, exported);
          if (found && !found.missing) report(found);
        }
        for (const [member, index] of uses) {
          const found = await traceExport(tables, implFile, member);
          if (!found) continue;
          if (!found.missing) {
            report(found);
            continue;
          }
          report({
            file: implFile,
            line: null,
            message: `does not export \`${member}\`, which ${rel(facade)}:${lineOf(source, index)} takes from it`,
          });
        }
      }
    }
  }
  return { problems: [...problems.values()], pairs };
}

const files = (await Promise.all(ROOTS.map(collectSourceFiles))).flat().sort();
const unresolved = [];
let specifierCount = 0;
let dataPathCount = 0;

for (const file of files) {
  const source = await readFile(file, 'utf8');
  for (const match of source.matchAll(SPECIFIER)) {
    specifierCount += 1;
    const specifier = match[1];
    const target = fileURLToPath(new URL(specifier, pathToFileURL(file)));
    if (!await exists(target)) {
      // Line number from the match offset — cheaper than tracking it per line.
      unresolved.push({ file, line: lineOf(source, match.index), specifier, target });
    }
  }
  for (const { index, specifier, target, dirOnly } of dataPaths(file, source)) {
    dataPathCount += 1;
    if (!await exists(target) && (dirOnly || !await exists(path.dirname(target)))) {
      unresolved.push({ file, line: lineOf(source, index), specifier, target });
    }
  }
}

for (const miss of unresolved) {
  console.error(`${path.relative(REPO_ROOT, miss.file)}:${miss.line}`);
  console.error(`  ${miss.specifier}  ->  ${miss.target}`);
}

const parity = await facadeParity(files);
for (const p of parity.problems) {
  console.error(`${path.relative(REPO_ROOT, p.file)}${p.line ? `:${p.line}` : ''} ${p.message}`);
}

const summary = `${specifierCount} relative specifiers and ${dataPathCount} module-relative paths across ${files.length} files`;
const paritySummary = `${parity.pairs} facade implementations`;
if (unresolved.length > 0 || parity.problems.length > 0) {
  console.error(`\n${unresolved.length} unresolved (${summary}); ${parity.problems.length} facade parity problem(s) (${paritySummary}).`);
  process.exit(1);
}
console.log(`OK — ${summary}, all resolve; ${paritySummary}, each exports what its facade takes.`);
