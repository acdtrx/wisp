#!/usr/bin/env node
/**
 * Enforce the backend's import fences (docs/CODING-RULES.md §7). Run with
 * `npm run check-fences` from the repo root; exits 1 on any violation.
 *
 * Rules 1–5, checked over backend/src and backend/migrations:
 *   1. Package fences — an external system's client library is imported only by
 *      the subsystem that owns it (PACKAGE_FENCES).
 *   2. Facades — a file outside a module that has an `index.js` facade imports
 *      that module only through its `index.js`.
 *   3. Strict managers — vmManager and containerManager import only Node
 *      builtins, npm packages, their own files and the mdns, networking and
 *      storage facades (never lib/host).
 *   4. Carved modules — host, networking, mdns and storage import their own
 *      files, each other's facades and `createAppError` from lib/appErrors.js,
 *      and nothing else of Wisp's glue.
 *   5. No import cycles (docs/ARCHITECTURE.md, Repo layout) — over static
 *      imports and the literal values of `import()` / `require()` calls, a
 *      ternary's both sides included: a cycle closed by a dynamic import still
 *      runs one module half-initialised. A reviewed cycle is one file → file
 *      edge in CYCLE_EXCEPTIONS; an entry whose edge no longer closes a cycle
 *      fails too, so the list only shrinks. Since an excepted edge would hide
 *      any new cycle through it, the files that import each other around those
 *      edges are listed too (CYCLE_GROUP): a file joining them fails, and so
 *      does a listed file that left.
 *
 *   6. The backend alone runs the state migrations, at its start
 *      (CODING-RULES §16): over every file git lists outside docs/ and
 *      Markdown, comments stripped, none outside backend/src names the runner
 *      (lib/stateMigrations.js, lib/stateMigrationLedger.js), and none but the
 *      runner, the checks and the root `test` script (its unit tests in
 *      backend/migrations/test/) reaches for the migrations directory.
 *
 *   7. Routes take no operation lock (CODING-RULES §7; ARCHITECTURE.md, Repo
 *      layout), checked in the same import scan as rules 1–5: no file under
 *      backend/src/routes imports lib/vmOperationLock.js or
 *      lib/containerOperationLock.js. A command's lock is the job starter's or
 *      its operation module's (lib/vmOperations.js, lib/containerOperations.js).
 *
 *   8. Outbound HTTP has one home (CODING-RULES §7): over the same files,
 *      comments stripped, none outside lib/downloads/ calls the global fetch —
 *      a `fetch(` that is no property's (`x.fetch(` is another object's), or
 *      `globalThis.fetch` / `globalThis['fetch']`. undici is rule 1's fence.
 *      A reviewed allowance is an EXCEPTIONS line with the specifier `fetch`.
 *
 * A module's darwin stubs are its own files. Migrations are glue.
 * Specifiers inside comments (JSDoc type imports) are skipped: they load
 * nothing. A reviewed allowance is one line in EXCEPTIONS.
 *
 * Same dumb-scan spirit as check-imports.mjs: static `import … from`,
 * `export … from`, side-effect imports; `import(…)` and `require(…)` calls,
 * including through `createRequire` — under an import alias, a destructuring
 * rename (`{ createRequire: cr }`) or a plain assignment (`const c =
 * createRequire`) — and through whatever name its result is assigned to.
 * A call's argument is read value by value (a ternary's condition skipped):
 * a literal is checked as written; a template or a concatenation by its leading
 * static prefix, which counts only when it lands inside one module's folder
 * (`./linux/${name}.js`, `'./vmManager/' + x` — reaching into that module) or in
 * a folder outside lib/. Anything else — no literal, a prefix on lib/ itself or
 * above it (`./${x}` from lib, `../lib/${x}`), a partial folder name
 * (`./vmManager${x}`), a substituted package template — is `<computed>`: a
 * violation unless EXCEPTIONS allows it.
 *
 * Known limits (a dumb scan, not a parser): a require function re-bound to
 * another name (`const s = r`) or called through `r.call(…)` / `r.apply(…)`
 * is not followed, nor is any property access other than `<object>.name(`.
 * The global fetch taken as a value (`const { fetch } = globalThis`,
 * `.then(fetch)`) is not seen, and a method named `fetch(` defined in an
 * object or a class outside lib/downloads/ is reported.
 * A new import between two files already in CYCLE_GROUP can close another
 * cycle through an excepted edge and pass: such cycles go when the excepted
 * edges do, and the search without those edges still catches the rest.
 */
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { argumentValues, callArgument, stripComments } from './sourceScan.mjs';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const ROOTS = ['backend/src', 'backend/migrations'];
const LIB = 'backend/src/lib';

/** package → directories (repo-relative, trailing slash) allowed to import it. */
const PACKAGE_FENCES = {
  'dbus-next': [`${LIB}/vmManager/linux/`, `${LIB}/mdns/linux/`],
  '@grpc/grpc-js': [`${LIB}/containerManager/linux/`],
  '@grpc/proto-loader': [`${LIB}/containerManager/linux/`],
  protobufjs: [`${LIB}/containerManager/linux/`],
  undici: [`${LIB}/downloads/`],
};

const STRICT_MANAGERS = ['vmManager', 'containerManager'];
const ROUTES = 'backend/src/routes/';
/** Rule 7: the lock modules, which no route imports. */
const LOCK_MODULES = [`${LIB}/vmOperationLock.js`, `${LIB}/containerOperationLock.js`];
const CARVED = ['host', 'networking', 'mdns', 'storage'];
/** Rule 8: the one home of outbound HTTP, and a call of the global fetch. */
const FETCH_HOME = `${LIB}/downloads/`;
const GLOBAL_FETCH = /(?<![\w$.])fetch\s*\(|(?<![\w$.])globalThis\s*(?:\.\s*fetch\b|\[\s*(['"`])fetch\1\s*\])/g;
/** The carved modules a strict manager may import (CODING-RULES §7). */
const MANAGER_CARVED = ['mdns', 'networking', 'storage'];

/**
 * Reviewed allowances: { file, specifier, reason }, both paths repo-relative.
 * Meet a new need with one added line here, flagged for review.
 */
const EXCEPTIONS = [
  {
    file: 'backend/src/lib/stateMigrations.js',
    specifier: '<computed>',
    reason: 'loads each migration file from the migrations directory it lists',
  },
];

/**
 * Reviewed import-cycle edges: { from, to, reason }, repo-relative. The graph
 * without them is acyclic; each one still closes a cycle.
 */
const CYCLE_EXCEPTIONS = [
  {
    from: `${LIB}/containerManager/linux/containerManagerLifecycle.js`,
    to: `${LIB}/containerManager/linux/containerManagerCreate.js`,
    reason: 'starting a container with no task builds its spec in Create, which imports Lifecycle',
  },
  {
    from: `${LIB}/containerManager/linux/containerManagerLifecycle.js`,
    to: `${LIB}/containerManager/linux/containerManagerList.js`,
    reason: 'the boot-time autostart and resume passes list containers; List imports Lifecycle',
  },
  {
    from: `${LIB}/containerManager/linux/containerManagerRestartPolicy.js`,
    to: `${LIB}/containerManager/linux/containerManagerLifecycle.js`,
    reason: 'a policy restart reads the task and starts the container; Lifecycle imports RestartPolicy',
  },
];

/**
 * The files that import each other, directly or not, around the
 * CYCLE_EXCEPTIONS edges (repo-relative). No other file may join them.
 */
const CYCLE_GROUP = [
  `${LIB}/containerManager/linux/containerManagerConfig.js`,
  `${LIB}/containerManager/linux/containerManagerCreate.js`,
  `${LIB}/containerManager/linux/containerManagerLifecycle.js`,
  `${LIB}/containerManager/linux/containerManagerList.js`,
  `${LIB}/containerManager/linux/containerManagerRestartPolicy.js`,
  `${LIB}/containerManager/linux/containerManagerServices.js`,
];

const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

async function collect(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') out.push(...await collect(full));
    } else if (/\.m?js$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const STATIC_IMPORT = /(?<![\w$.])import\s*(?:([\w$*{}\s,]+?)\s*from\s*)?(['"])([^'"\n]+)\2/g;
const EXPORT_FROM = /(?<![\w$.])export\s*(?:\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(['"])([^'"\n]+)\1/g;
const DYNAMIC_IMPORT = /(?<![\w$.])import\s*\(/g;
const REQUIRE_CALL = /(?<![\w$.])require\s*\(/g;
const CREATE_REQUIRE_ALIASES = [
  /\bcreateRequire\s+as\s+([\w$]+)/g, // import { createRequire as cr }
  /\bcreateRequire\s*:\s*([\w$]+)/g, // const { createRequire: cr } = …
  /(?<![\w$.])([\w$]+)\s*=(?!=)\s*(?:[\w$.]+\.)?createRequire\b(?!\s*\()/g, // c = createRequire
];

function escapeName(name) {
  return name.replace(/\$/g, '\\$');
}

/**
 * Every call that loads a module through createRequire: `createRequire` and its
 * import aliases (`import { createRequire as cr }`), called directly —
 * `cr(import.meta.url)('x')` — or through the name their result is assigned to,
 * declared or not (`const r = cr(…)`, `r = mod.createRequire(…)`).
 */
function createRequireCalls(code) {
  const names = ['createRequire', ...CREATE_REQUIRE_ALIASES.flatMap((re) => [...code.matchAll(re)].map((m) => m[1]))];
  const calls = [];
  for (const name of names.map(escapeName)) {
    const direct = new RegExp(`(?<![\\w$.])(?:[\\w$.]+\\.)?${name}\\s*\\([^()]*(?:\\([^()]*\\))*[^()]*\\)\\s*\\(`, 'g');
    calls.push(...code.matchAll(direct));
    const binding = new RegExp(`(?<![\\w$.])([\\w$]+)\\s*=(?!=)\\s*(?:[\\w$.]+\\.)?${name}\\s*\\(`, 'g');
    for (const b of code.matchAll(binding)) {
      calls.push(...code.matchAll(new RegExp(`(?<![\\w$.])${escapeName(b[1])}\\s*\\(`, 'g')));
    }
  }
  return calls;
}

/**
 * The specifiers a dynamic import()/require() argument can name:
 * `{ specifier, prefix }`, where `prefix` marks the static start of a template
 * or a concatenation (see the header), and `<computed>` a value with none.
 */
function specifiersOfArgument(arg) {
  const found = [];
  for (const { text, isCondition } of argumentValues(arg)) {
    if (isCondition) continue;
    let m;
    if ((m = /^(['"])([^'"\n]*)\1$/.exec(text))) {
      found.push({ specifier: m[2], prefix: false });
    } else if ((m = /^`([^`]*)`$/.exec(text))) {
      if (!m[1].includes('${')) found.push({ specifier: m[1], prefix: false });
      else found.push({ specifier: m[1].split('${')[0], prefix: true });
    } else if ((m = /^(['"])([^'"\n]*)\1\s*\+/.exec(text)) || (m = /^`([^`$]*)`\s*\+/.exec(text))) {
      found.push({ specifier: m[2] ?? m[1], prefix: true });
    } else {
      found.push({ specifier: '<computed>', prefix: false });
    }
  }
  return found;
}

/**
 * A static prefix as an import target: the folder it names (its own, when it
 * ends in `/`; its parent, when its last segment is cut short), or `<computed>`
 * when that folder is lib/ itself or above it, so the value could reach any
 * module, or the prefix isn't relative.
 */
function prefixTarget(file, prefix, rel) {
  if (!/^\.\.?\//.test(prefix)) return '<computed>';
  const resolved = path.resolve(path.dirname(file), prefix);
  const folder = prefix.endsWith('/') ? resolved : path.dirname(resolved);
  // Absolute paths: lib/ itself, or any folder above it up to `/`, could reach
  // any module (a repo-relative path is '' or '../…' at the root and above).
  const libAbs = path.join(REPO_ROOT, LIB);
  if (libAbs === folder || libAbs.startsWith(`${folder.replace(/\/$/, '')}${path.sep}`)) return '<computed>';
  return `${rel(folder)}/`;
}

/** `[{ index, specifier, clause }]` for one stripped source. */
function importsOf(code) {
  const found = [];
  for (const m of code.matchAll(STATIC_IMPORT)) {
    found.push({ index: m.index, specifier: m[3], clause: m[1] ?? '' });
  }
  for (const m of code.matchAll(EXPORT_FROM)) {
    found.push({ index: m.index, specifier: m[2], clause: null });
  }
  const calls = [...code.matchAll(DYNAMIC_IMPORT), ...code.matchAll(REQUIRE_CALL), ...createRequireCalls(code)];
  const seen = new Set();
  for (const m of calls) {
    if (seen.has(m.index)) continue;
    seen.add(m.index);
    for (const { specifier, prefix } of specifiersOfArgument(callArgument(code, m.index + m[0].length))) {
      found.push({ index: m.index, specifier, clause: null, prefix });
    }
  }
  return found;
}

function packageName(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** The lib module a repo-relative path belongs to, or null (flat glue, routes, scripts). */
function moduleOf(rel) {
  if (!rel.startsWith(`${LIB}/`)) return null;
  const parts = rel.slice(LIB.length + 1).split('/');
  return parts.length > 1 ? parts[0] : null;
}

/**
 * The groups of files in `edges` (file → [{ to, line }]) that import each other,
 * directly or not (strongly connected components with a cycle), as arrays.
 */
function cycleGroups(edges) {
  let next = 0;
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  const visit = (v) => {
    index.set(v, next);
    low.set(v, next);
    next += 1;
    stack.push(v);
    onStack.add(v);
    for (const { to } of edges.get(v) ?? []) {
      if (!index.has(to)) {
        visit(to);
        low.set(v, Math.min(low.get(v), low.get(to)));
      } else if (onStack.has(to)) {
        low.set(v, Math.min(low.get(v), index.get(to)));
      }
    }
    if (low.get(v) !== index.get(v)) return;
    const component = [];
    let w;
    do {
      w = stack.pop();
      onStack.delete(w);
      component.push(w);
    } while (w !== v);
    if (component.length > 1 || (edges.get(v) ?? []).some((e) => e.to === v)) components.push(component);
  };
  for (const v of [...edges.keys()].sort()) if (!index.has(v)) visit(v);
  return components;
}

/** Import cycles in `edges`: one per cycle group, as its edges `[{ from, to, line }]` in order. */
function findCycles(edges) {
  // A cycle through the group's first file: a path back to it inside the group.
  return cycleGroups(edges).map((component) => {
    const members = new Set(component);
    const start = [...component].sort()[0];
    const seen = new Set([start]);
    const walk = (v, path) => {
      for (const e of edges.get(v) ?? []) {
        if (!members.has(e.to)) continue;
        const step = [...path, { from: v, ...e }];
        if (e.to === start) return step;
        if (seen.has(e.to)) continue;
        seen.add(e.to);
        const found = walk(e.to, step);
        if (found) return found;
      }
      return null;
    };
    return walk(start, []);
  });
}

/** Whether `to` is reachable from `from` in `edges`. */
function reaches(edges, from, to) {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length > 0) {
    const v = queue.shift();
    if (v === to) return true;
    for (const e of edges.get(v) ?? []) {
      if (!seen.has(e.to)) {
        seen.add(e.to);
        queue.push(e.to);
      }
    }
  }
  return false;
}

/**
 * Rule 6. Running migrations takes the runner's name or the migrations
 * directory: a second runner would load `backend/migrations/0*.js` itself and
 * call `run()`, without naming the runner.
 */
const RUNNER_NAME = /stateMigration/;
const MIGRATIONS_DIR_REF = /backend\/migrations\b|[/'"`]migrations[/'"`]/;
/**
 * The files that may reference the migrations directory: the runner, the
 * checks that scan it, and the test script that reaches its unit tests.
 */
const MIGRATIONS_DIR_USERS = new Set([
  'backend/src/lib/stateMigrations.js',
  'scripts/check-fences.mjs',
  'scripts/check-imports.mjs',
  'package.json', // `npm test` runs backend/migrations/test/, which the runner never loads (a subdirectory)
]);
const SHELL_SHEBANG = /^#!\s*\S*\/(?:env\s+)?(?:bash|sh)(?:\s|$)/;

/**
 * The repo's files as git lists them — tracked plus untracked-not-ignored, so a
 * new file counts before it is committed and nothing ignored (logs, builds,
 * node_modules, other worktrees) does — less the docs: `docs/` and Markdown.
 */
function repoFiles() {
  const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).split('\0').filter(Boolean);
  return [...new Set(listed)]
    .filter((rel) => !rel.startsWith('docs/') && !rel.endsWith('.md'))
    .filter((rel) => {
      try {
        return statSync(path.join(REPO_ROOT, rel)).isFile();
      } catch {
        return false; // listed by git but deleted in the working tree
      }
    })
    .sort();
}

/**
 * A file's text without its comments: JavaScript through the shared stripper;
 * shell scripts, systemd units and YAML without their `#` (and `;`) comment lines.
 * Other files are taken whole.
 */
function withoutComments(rel, text) {
  if (/\.[cm]?jsx?$/.test(rel)) return stripComments(text);
  const lines = text.split('\n');
  if (/\.(sh|service|ya?ml)$/.test(rel) || SHELL_SHEBANG.test(lines[0])) {
    return lines.map((line) => (/^\s*[#;]/.test(line) ? '' : line)).join('\n');
  }
  return text;
}

/** Rule 6: the files outside the runner that name it or reach for the migrations directory. */
async function migrationsRunElsewhere() {
  const found = [];
  for (const rel of repoFiles()) {
    if (rel === 'scripts/check-fences.mjs') continue;
    const raw = await readFile(path.join(REPO_ROOT, rel));
    if (raw.includes(0)) continue; // binary
    const lines = withoutComments(rel, raw.toString('utf8')).split('\n');
    lines.forEach((text, i) => {
      if (!rel.startsWith('backend/src/') && RUNNER_NAME.test(text)) {
        found.push(`${rel}:${i + 1} — names the state-migration runner: only the backend runs migrations, at its start (CODING-RULES §16)`);
      } else if (!MIGRATIONS_DIR_USERS.has(rel) && MIGRATIONS_DIR_REF.test(text)) {
        found.push(`${rel}:${i + 1} — reaches for the migrations directory: only the backend's runner loads migrations (CODING-RULES §16)`);
      }
    });
  }
  return found;
}

async function main() {
  const files = (await Promise.all(ROOTS.map((r) => collect(path.join(REPO_ROOT, r))))).flat().sort();
  const rel = (abs) => path.relative(REPO_ROOT, abs).split(path.sep).join('/');

  const facaded = new Set();
  for (const f of files) {
    const m = /^backend\/src\/lib\/([^/]+)\/index\.js$/.exec(rel(f));
    if (m) facaded.add(m[1]);
  }

  const violations = [];
  const known = new Set(files.map(rel));
  /** repo-relative file → [{ to, line }]: the import graph inside the scanned roots. */
  const edges = new Map(files.map((f) => [rel(f), []]));
  let count = 0;
  for (const file of files) {
    const fileRel = rel(file);
    const fileModule = moduleOf(fileRel);
    const source = await readFile(file, 'utf8');
    const code = stripComments(source);
    if (!fileRel.startsWith(FETCH_HOME) && !EXCEPTIONS.some((e) => e.file === fileRel && e.specifier === 'fetch')) {
      for (const m of code.matchAll(GLOBAL_FETCH)) {
        const line = source.slice(0, m.index).split('\n').length;
        violations.push(`${fileRel}:${line} fetch — outbound HTTP goes through lib/downloads: ssrfSafeFetch, or fetchOperatorEndpoint for an endpoint only the operator sets (CODING-RULES §7)`);
      }
    }
    for (const found of importsOf(code)) {
      const { index, clause } = found;
      const specifier = found.prefix ? prefixTarget(file, found.specifier, rel) : found.specifier;
      count += 1;
      const line = source.slice(0, index).split('\n').length;
      if (!found.prefix && specifier.startsWith('.')) {
        const to = rel(path.resolve(path.dirname(file), specifier));
        if (known.has(to)) edges.get(fileRel).push({ to, line });
      }
      const report = (why) => {
        if (EXCEPTIONS.some((e) => e.file === fileRel && e.specifier === specifier)) return;
        violations.push(`${fileRel}:${line} ${specifier} — ${why} (CODING-RULES §7)`);
      };

      if (specifier === '<computed>') {
        report('computed import specifier: the fence lint cannot check it');
        continue;
      }
      if (!found.prefix && !specifier.startsWith('.')) {
        if (BUILTINS.has(specifier)) continue;
        const pkg = packageName(specifier);
        const allowed = PACKAGE_FENCES[pkg];
        if (allowed && !allowed.some((dir) => fileRel.startsWith(dir))) {
          report(`${pkg} may be imported only in ${allowed.join(', ')}`);
        }
        continue;
      }

      // A static prefix arrives as the repo-relative folder it lands in (ending in
      // `/`: reaching inside a module's folder counts as reaching into the module).
      const targetRel = found.prefix ? specifier : rel(path.resolve(path.dirname(file), specifier));
      const targetModule = moduleOf(targetRel);

      if (fileRel.startsWith(ROUTES) && LOCK_MODULES.includes(targetRel)) {
        report('a route takes no operation lock: call the command in lib/vmOperations.js or lib/containerOperations.js');
        continue;
      }

      if (targetModule && targetModule !== fileModule && facaded.has(targetModule)
        && targetRel !== `${LIB}/${targetModule}/index.js`) {
        report(`import lib/${targetModule}/ through its facade, lib/${targetModule}/index.js`);
        continue;
      }

      if (fileModule && (STRICT_MANAGERS.includes(fileModule) || CARVED.includes(fileModule))) {
        if (targetModule === fileModule) continue;
        const isCarved = CARVED.includes(fileModule);
        if (targetModule && (isCarved ? CARVED : MANAGER_CARVED).includes(targetModule)) continue;
        if (isCarved && targetRel === `${LIB}/appErrors.js`) {
          const names = (clause || '').replace(/[{}\s]/g, '').split(',').filter(Boolean);
          if (names.length > 0 && names.every((n) => n === 'createAppError')) continue;
          report('carved modules may import only createAppError from lib/appErrors.js');
          continue;
        }
        report(isCarved
          ? `carved module lib/${fileModule}/ may import only its own files, the carved facades and createAppError`
          : `strict manager lib/${fileModule}/ may import only its own files and the mdns, networking and storage facades`);
      }
    }
  }

  const excepted = (from, to) => CYCLE_EXCEPTIONS.some((e) => e.from === from && e.to === to);
  for (const e of CYCLE_EXCEPTIONS) {
    const edge = (edges.get(e.from) ?? []).find((x) => x.to === e.to);
    if (!edge) {
      violations.push(`${e.from} → ${e.to} — CYCLE_EXCEPTIONS lists an import that no longer exists: remove the entry`);
    } else if (!reaches(edges, e.to, e.from)) {
      violations.push(`${e.from}:${edge.line} → ${e.to} — CYCLE_EXCEPTIONS lists an import that no longer closes a cycle: remove the entry`);
    }
  }
  const exceptionFiles = new Set(CYCLE_EXCEPTIONS.flatMap((e) => [e.from, e.to]));
  const group = new Set(cycleGroups(edges).filter((g) => g.some((f) => exceptionFiles.has(f))).flat());
  for (const file of [...group].sort()) {
    if (CYCLE_GROUP.includes(file)) continue;
    const through = [];
    for (const e of edges.get(file)) if (group.has(e.to)) through.push(`  ${file}:${e.line} → ${e.to}`);
    for (const [from, out] of edges) {
      for (const e of out) if (e.to === file && group.has(from)) through.push(`  ${from}:${e.line} → ${file}`);
    }
    violations.push([
      `${file} — joins the import cycle around the CYCLE_EXCEPTIONS edges, through:`,
      ...through,
    ].join('\n'));
  }
  for (const file of CYCLE_GROUP) {
    if (!group.has(file)) violations.push(`${file} — CYCLE_GROUP lists a file no longer in that cycle: remove the entry`);
  }

  const acyclic = new Map([...edges].map(([from, out]) => [from, out.filter((e) => !excepted(from, e.to))]));
  const cycles = findCycles(acyclic);
  for (const cycle of cycles) {
    violations.push([
      'import cycle — the import graph stays acyclic (ARCHITECTURE.md, Repo layout):',
      ...cycle.map((e) => `  ${e.from}:${e.line} → ${e.to}`),
    ].join('\n'));
  }

  violations.push(...await migrationsRunElsewhere());

  for (const v of violations) console.error(v);
  const summary = `${count} imports across ${files.length} files`;
  const cycleSummary = `no import cycle outside the ${CYCLE_EXCEPTIONS.length} listed, among the ${CYCLE_GROUP.length} files listed`;
  const runnerSummary = 'only the backend runs the state migrations';
  const fetchSummary = 'no global fetch outside lib/downloads/';
  if (violations.length > 0) {
    console.error(`\n${violations.length} fence violation(s) (${summary}).`);
    process.exit(1);
  }
  console.log(`OK — ${summary}, all inside their fences; ${fetchSummary}; ${cycleSummary}; ${runnerSummary}.`);
}

await main();
