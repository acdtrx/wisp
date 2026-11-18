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
 * Named imports: every name one backend file imports from another is exported
 * there, followed through re-exports (see namedImports). The Mac never loads
 * the `linux/` files, so nothing else would catch a misnamed import in one
 * before it fails the backend's boot on a host.
 *
 * Facade parity: a platform facade (`lib/<module>/index.js`) binds each
 * implementation with `const impl = await import(isLinux ? './linux/x.js' :
 * './darwin/x.js')` and re-exports `impl.name`. A name one side lacks is
 * `undefined` at call time, and only on that platform. So every `impl.name` the
 * facade reads must be exported by each file its import can load: both sides of
 * the ternary, or the one side of a single-platform import. Exports are read as
 * written (`export function`, `export const`, `export { … }`); a name an
 * implementation re-exports with `export { … } from` is followed to the file
 * that defines it. What the scan cannot follow fails, with file and line:
 *   - an implementation that uses `export *`;
 *   - in a facade, a string literal naming a file in the module's own `linux/`
 *     or `darwin/` outside a `const name = … await import(…)` binding (another
 *     binding form, a static import, a `require()`);
 *   - an `import()` whose argument is not plain string literals (a computed
 *     specifier; a ternary's condition is fine);
 *   - a use of a binding other than `name.member` (destructuring, an alias,
 *     `name[…]`, `name?.…`);
 *   - a module with both a `linux/` and a `darwin/` folder whose facade binds
 *     neither.
 *
 * Known limits (a dumb scan, not a parser): a binding's name inside a string, as
 * an object key or as a shadowing local fails a correct facade; a template
 * literal with a `${…}` outside an import() is not read; export lists are read
 * with strings left in, so a string holding `export function x` counts as an
 * export.
 */
import { access, readdir, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

import { argumentValues, callArgument, stripComments } from './sourceScan.mjs';

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

const STRING_LITERAL = /^(['"])([^'"\n]*)\1$/;

/**
 * A facade's imports of its own platform files: any relative specifier that
 * resolves into the module's `linux/` or `darwin/` folder. `bindings`: each
 * `const name = …` statement whose `import()` calls load such files, with every
 * target of the whole statement. `stray`: the index of every other string
 * literal that resolves there (another binding form, a static import, a
 * `require()`). `computed`: the index of every `import()` whose argument is not
 * plain string literals (a ternary's condition aside), which no scan can resolve.
 */
function platformImports(code, facade) {
  const moduleDir = path.dirname(facade);
  const platformDirs = ['linux', 'darwin'].map((d) => path.join(moduleDir, d) + path.sep);
  const platformTarget = (specifier) => {
    if (!specifier.startsWith('.')) return null;
    const target = path.resolve(moduleDir, specifier);
    return platformDirs.some((d) => target.startsWith(d)) ? target : null;
  };

  const calls = [];
  const computed = [];
  for (const m of code.matchAll(/(?<![\w$.])import\s*\(/g)) {
    const open = m.index + m[0].length;
    const arg = callArgument(code, open);
    const values = argumentValues(arg).filter((v) => !v.isCondition);
    const literals = values.map((v) => STRING_LITERAL.exec(v.text)?.[2]);
    if (literals.some((l) => l === undefined)) {
      computed.push(m.index);
      continue;
    }
    const targets = literals.map(platformTarget).filter(Boolean);
    const argStart = code.indexOf(arg, open);
    if (targets.length > 0) calls.push({ index: m.index, targets, argStart, argEnd: argStart + arg.length });
  }

  const bindings = [];
  const bound = new Set();
  for (const m of code.matchAll(/(?<![\w$.])const\s+([\w$]+)\s*=/dg)) {
    const end = statementEnd(code, m.index + m[0].length);
    const inside = calls.filter((c) => c.index > m.index && c.index < end);
    if (inside.length === 0) continue;
    for (const c of inside) bound.add(c.index);
    bindings.push({
      name: m[1],
      declaredAt: m.indices[1][0],
      targets: [...new Set(inside.flatMap((c) => c.targets))],
    });
  }

  // Every literal naming a platform file outside a bound import() is stray.
  const boundArgs = calls.filter((c) => bound.has(c.index));
  const stray = [];
  for (const m of code.matchAll(/(['"`])(\.\.?\/[^'"`\n]*)\1/g)) {
    if (m[1] === '`' && m[2].includes('${')) continue;
    if (!platformTarget(m[2])) continue;
    if (boundArgs.some((c) => m.index >= c.argStart && m.index < c.argEnd)) continue;
    stray.push(m.index);
  }
  return { bindings, stray, computed };
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
 * source lacks, an `export *`). `checker` names the check in that last message.
 */
async function traceExport(tables, file, name, checker = 'facade parity', seen = new Set()) {
  const key = `${file}#${name}`;
  if (seen.has(key) || !await exists(file)) return null; // a loop, or a missing file the specifier scan reports
  seen.add(key);
  if (!tables.has(file)) tables.set(file, await exportTable(file));
  const table = tables.get(file);
  if (table === null) {
    return { file, line: 1, message: `uses \`export *\`: ${checker} cannot see what it exports (list the names)` };
  }
  const entry = table.get(name);
  if (!entry) return { missing: true };
  if (!entry.from) return null;
  const found = await traceExport(tables, entry.from, entry.sourceName, checker, seen);
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
async function facadeParity(files, tables) {
  const problems = new Map();
  const report = (p) => problems.set(`${p.file}:${p.line}:${p.message}`, p);
  let pairs = 0;
  const facades = files.filter((f) => /\/backend\/src\/lib\/[^/]+\/index\.js$/.test(f));
  for (const facade of facades) {
    const source = await readFile(facade, 'utf8');
    const code = stripComments(source);
    const { bindings, stray, computed } = platformImports(code, facade);
    const at = (index, message) => report({ file: facade, line: lineOf(source, index), message });
    for (const index of stray) {
      at(index, 'imports a platform file in a form facade parity cannot follow: bind it as `const name = await import(…)`');
    }
    for (const index of computed) {
      at(index, 'imports a computed specifier: a facade names its files as string literals');
    }
    const moduleDir = path.dirname(facade);
    if (bindings.length === 0 && await exists(path.join(moduleDir, 'linux')) && await exists(path.join(moduleDir, 'darwin'))) {
      report({
        file: facade,
        line: 1,
        message: 'has linux/ and darwin/ implementations but no `const name = await import(…)` binding parity can read',
      });
    }
    for (const { name, declaredAt, targets } of bindings) {
      // Only `name.member` can be checked: any other use (destructuring, an alias,
      // `name[…]`, `name?.…`) reads names parity cannot see.
      const uses = new Map();
      const escaped = name.replace(/\$/g, '\\$');
      for (const m of code.matchAll(new RegExp(`(?<![\\w$.])${escaped}(?![\\w$])(\\s*\\.\\s*([\\w$]+))?`, 'g'))) {
        if (m.index === declaredAt) continue;
        if (m[2] === undefined) {
          at(m.index, `uses \`${name}\` other than as \`${name}.member\`: facade parity cannot follow it`);
        } else if (!uses.has(m[2])) {
          uses.set(m[2], m.index);
        }
      }
      for (const implFile of targets) {
        pairs += 1;
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

/**
 * The names in a `{ … }` list, as `[{ imported, local }]`, null when unreadable:
 * an import's or re-export's (`a as b`) or a destructuring's (`a: b`).
 */
function nameList(list, rename) {
  const pattern = new RegExp(`^([\\w$]+)(?:${rename === 'as' ? '\\s+as\\s+' : '\\s*:\\s*'}([\\w$]+))?$`);
  const names = [];
  for (const part of list.split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = pattern.exec(part);
    if (!m) return null;
    names.push({ imported: m[1], local: m[2] ?? m[1] });
  }
  return names;
}

const RELATIVE_MODULE = /^\.\.?\/.*\.m?js$/;

/**
 * Named imports between backend files, the backend having no build step and the
 * Mac never loading the `linux/` files: each name a file takes from another must
 * be exported there (followed through re-exports, as parity does). Read:
 * `import { a, b as c } from './y.js'` and a default import;
 * `export { … } from './y.js'`; `const { a, b: c } = await import('./y.js')`;
 * and a namespace, `import * as ns from './y.js'` or
 * `const ns = await import('./y.js')`, whose `ns.member` uses are checked. A
 * relative import of a backend file in any other form fails, since its names
 * cannot be checked; a facade's platform imports are parity's.
 *
 * Known limit: a namespace handed on whole (`{ vmManager }` in the migration
 * context) is not followed to where its members are read.
 */
async function namedImports(files, tables) {
  const problems = new Map();
  const report = (p) => problems.set(`${p.file}:${p.line}:${p.message}`, p);
  let count = 0;

  /** Check that `target` exports `name`, for the import at `index` of `file`. */
  const expect = async (file, source, index, target, name) => {
    count += 1;
    if (!await exists(target)) return; // reported by the specifier scan
    const found = await traceExport(tables, target, name, 'the import check');
    if (!found) return;
    const line = lineOf(source, index);
    if (found.missing) {
      report({ file, line, message: `imports \`${name}\` from ${rel(target)}, which does not export it` });
    } else {
      report(found);
    }
  };
  /**
   * Check every `ns.member` use of namespace `ns` (declared at `declaredAt`)
   * against `target`. `ns?.x`, `ns[…]` and `{ … } = ns` read names the scan cannot
   * check, and fail; `ns` handed on whole is the one use let through.
   */
  const expectMembers = async (file, source, code, ns, declaredAt, target) => {
    const escaped = ns.replace(/\$/g, '\\$');
    // String contents blanked, so `'./ns.js'` is not read as a use of `ns`.
    const bare = code.replace(/(['"`])(?:\\.|(?!\1)[^\\\n])*\1/g, (q) => q[0] + ' '.repeat(q.length - 2) + q[0]);
    for (const use of bare.matchAll(new RegExp(`(?<![\\w$.])${escaped}(?![\\w$])(\\s*\\.\\s*([\\w$]+))?`, 'g'))) {
      if (use.index === declaredAt) continue;
      if (use[2] !== undefined) {
        await expect(file, source, use.index, target, use[2]);
        continue;
      }
      const after = bare.slice(use.index + ns.length).trimStart();
      const before = bare.slice(0, use.index).trimEnd();
      if (after.startsWith('?.') || after.startsWith('[') || /\}\s*=$/.test(before)) {
        unreadable(file, source, use.index, `\`${ns}\` read other than as \`${ns}.member\``);
      }
    }
  };
  const unreadable = (file, source, index, what) => report({
    file,
    line: lineOf(source, index),
    message: `${what}: its names cannot be checked`,
  });

  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const code = stripComments(source);
    const resolve = (specifier) => fileURLToPath(new URL(specifier, pathToFileURL(file)));
    const isFacade = /\/backend\/src\/lib\/[^/]+\/index\.js$/.test(file);

    for (const m of code.matchAll(/(?<![\w$.])import\s*([^'";()]*?)\s*from\s*(['"])([^'"\n]+)\2/g)) {
      if (!RELATIVE_MODULE.test(m[3])) continue;
      const target = resolve(m[3]);
      const clause = /^(?:([\w$]+)\s*(?:,\s*|$))?(?:\{([^}]*)\}|\*\s*as\s+([\w$]+))?$/.exec(m[1].trim());
      const names = clause && clause[2] !== undefined ? nameList(clause[2], 'as') : [];
      if (!clause || !m[1].trim() || names === null) {
        unreadable(file, source, m.index, `an import from ${m[3]} in a form the scan cannot read`);
        continue;
      }
      if (clause[1]) await expect(file, source, m.index, target, 'default');
      for (const { imported } of names) await expect(file, source, m.index, target, imported);
      if (clause[3]) {
        const declaredAt = m.index + m[0].search(new RegExp(`\\b${clause[3].replace(/\$/g, '\\$')}\\b`));
        await expectMembers(file, source, code, clause[3], declaredAt, target);
      }
    }

    for (const m of code.matchAll(/(?<![\w$.])export\s*\{([^}]*)\}\s*from\s*(['"])([^'"\n]+)\2/g)) {
      if (!RELATIVE_MODULE.test(m[3])) continue;
      const names = nameList(m[1], 'as');
      if (names === null) {
        unreadable(file, source, m.index, `a re-export from ${m[3]} in a form the scan cannot read`);
        continue;
      }
      for (const { imported } of names) await expect(file, source, m.index, resolve(m[3]), imported);
    }

    const destructured = new Set();
    for (const m of code.matchAll(/(?<![\w$.])(?:const|let)\s*\{([^}]*)\}\s*=\s*await\s+import\s*\(\s*(['"])([^'"\n]+)\2\s*\)/g)) {
      if (!RELATIVE_MODULE.test(m[3])) continue;
      destructured.add(m.index + m[0].indexOf('import'));
      const names = nameList(m[1], ':');
      if (names === null) {
        unreadable(file, source, m.index, `a dynamic import of ${m[3]} in a form the scan cannot read`);
        continue;
      }
      for (const { imported } of names) await expect(file, source, m.index, resolve(m[3]), imported);
    }
    for (const m of code.matchAll(/(?<![\w$.])(?:const|let)\s+([\w$]+)\s*=\s*await\s+import\s*\(\s*(['"])([^'"\n]+)\2\s*\)/dg)) {
      if (!RELATIVE_MODULE.test(m[3])) continue;
      if (isFacade && /^\.\/(?:linux|darwin)\//.test(m[3])) continue; // parity's
      destructured.add(m.index + m[0].indexOf('import'));
      await expectMembers(file, source, code, m[1], m.indices[1][0], resolve(m[3]));
    }
    for (const m of code.matchAll(/(?<![\w$.])import\s*\(/g)) {
      if (destructured.has(m.index)) continue;
      const literals = argumentValues(callArgument(code, m.index + m[0].length))
        .filter((v) => !v.isCondition)
        .map((v) => /^(['"])([^'"\n]+)\1$/.exec(v.text)?.[2])
        .filter((l) => l && RELATIVE_MODULE.test(l));
      if (literals.length === 0) continue; // computed: check-fences' business
      if (isFacade && literals.every((l) => /^\.\/(?:linux|darwin)\//.test(l))) continue; // parity's
      unreadable(file, source, m.index, `a dynamic import of ${literals.join(' or ')} not destructured as \`const { … } = await import('…')\``);
    }
  }
  return { problems: [...problems.values()], count };
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

const tables = new Map();
const parity = await facadeParity(files, tables);
const named = await namedImports(files, tables);
for (const p of [...parity.problems, ...named.problems]) {
  console.error(`${path.relative(REPO_ROOT, p.file)}${p.line ? `:${p.line}` : ''} ${p.message}`);
}

const summary = `${specifierCount} relative specifiers and ${dataPathCount} module-relative paths across ${files.length} files`;
const paritySummary = `${parity.pairs} facade implementations`;
const namedSummary = `${named.count} imported names`;
if (unresolved.length > 0 || parity.problems.length > 0 || named.problems.length > 0) {
  console.error(`\n${unresolved.length} unresolved (${summary}); ${parity.problems.length} facade parity problem(s) (${paritySummary}); `
    + `${named.problems.length} named import problem(s) (${namedSummary}).`);
  process.exit(1);
}
console.log(`OK — ${summary}, all resolve; ${paritySummary}, each exports what its facade takes; `
  + `${namedSummary}, each exported where it is imported from.`);
