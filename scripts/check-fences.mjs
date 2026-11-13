#!/usr/bin/env node
/**
 * Enforce the backend's import fences (docs/CODING-RULES.md §7). Run with
 * `npm run check-fences` from the repo root; exits 1 on any violation.
 *
 * Rules, checked over backend/src, backend/scripts and backend/migrations:
 *   1. Package fences — an external system's client library is imported only by
 *      the subsystem that owns it (PACKAGE_FENCES).
 *   2. Facades — a file outside a module that has an `index.js` facade imports
 *      that module only through its `index.js`.
 *   3. Strict managers — vmManager and containerManager import only Node
 *      builtins, npm packages, their own files and the mdns, networking and
 *      storage facades (never lib/host).
 *   4. Carved modules — host, networking, mdns and storage import their own
 *      files, each other's facades and `createAppError` from lib/routeErrors.js,
 *      and nothing else of Wisp's glue.
 *
 * A module's darwin stubs are its own files. Scripts and migrations are glue.
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
 */
import { readdir, readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const ROOTS = ['backend/src', 'backend/scripts', 'backend/migrations'];
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
const CARVED = ['host', 'networking', 'mdns', 'storage'];
/** The carved modules a strict manager may import (CODING-RULES §7). */
const MANAGER_CARVED = ['mdns', 'networking', 'storage'];

/**
 * Reviewed allowances: { file, specifier, reason }, both paths repo-relative.
 * Meet a new need with one added line here, flagged for review.
 */
const EXCEPTIONS = [
  {
    file: 'backend/scripts/migrate.mjs',
    specifier: '<computed>',
    reason: 'loads each migration file from the migrations directory it lists',
  },
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

const REGEX_PRECEDERS = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));
const REGEX_KEYWORDS = /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/;

/** Blank out comments (newlines kept, so line numbers hold); strings stay. */
function stripComments(src) {
  let out = '';
  let i = 0;
  let lastSignificant = '';
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      lastSignificant = c;
      continue;
    }
    if (c === '/' && (lastSignificant === '' || REGEX_PRECEDERS.has(lastSignificant)
      || REGEX_KEYWORDS.test(out.trimEnd()))) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
        j += 1;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      lastSignificant = 'a';
      continue;
    }
    if (!/\s/.test(c)) lastSignificant = /[\w$]/.test(c) ? 'a' : c;
    out += c;
    i += 1;
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

/** The text between the `(` that ends at `open` and its matching `)`. */
function callArgument(code, open) {
  let depth = 1;
  let j = open;
  while (j < code.length && depth > 0) {
    if (code[j] === '(') depth += 1;
    else if (code[j] === ')') depth -= 1;
    j += 1;
  }
  return code.slice(open, j - 1).trim();
}

/**
 * Split a call's first argument (up to a depth-0 `,`) at its depth-0 `?` / `:`
 * (and `||`, `??`) — outside literals, templates and brackets — into
 * `[{ text, isCondition }]`: the part before each `?` is a ternary's condition,
 * the rest are the values it can take.
 */
function argumentValues(arg) {
  const parts = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  const cut = (end, sep) => {
    parts.push({ text: arg.slice(start, end).trim(), isCondition: sep === '?' });
  };
  let end = arg.length;
  while (i < arg.length) {
    const c = arg[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < arg.length && arg[j] !== c) j += arg[j] === '\\' ? 2 : 1;
      i = j + 1;
      continue;
    }
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) depth -= 1;
    else if (depth === 0 && c === ',') {
      // Only the first argument names the module (import()'s second is options).
      end = i;
      break;
    } else if (depth === 0 && (c === '?' || c === ':') && arg[i + 1] !== '?' && arg[i + 1] !== '.') {
      cut(i, c);
      start = i + 1;
    } else if (depth === 0 && (arg.startsWith('||', i) || arg.startsWith('??', i))) {
      cut(i, '|');
      start = i + 2;
      i += 2;
      continue;
    }
    i += 1;
  }
  cut(end, null);
  return parts;
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
  const folderRel = rel(folder);
  if (`${LIB}/`.startsWith(`${folderRel}/`)) return '<computed>';
  return `${folderRel}/`;
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

async function main() {
  const files = (await Promise.all(ROOTS.map((r) => collect(path.join(REPO_ROOT, r))))).flat().sort();
  const rel = (abs) => path.relative(REPO_ROOT, abs).split(path.sep).join('/');

  const facaded = new Set();
  for (const f of files) {
    const m = /^backend\/src\/lib\/([^/]+)\/index\.js$/.exec(rel(f));
    if (m) facaded.add(m[1]);
  }

  const violations = [];
  let count = 0;
  for (const file of files) {
    const fileRel = rel(file);
    const fileModule = moduleOf(fileRel);
    const source = await readFile(file, 'utf8');
    const code = stripComments(source);
    for (const found of importsOf(code)) {
      const { index, clause } = found;
      const specifier = found.prefix ? prefixTarget(file, found.specifier, rel) : found.specifier;
      count += 1;
      const line = source.slice(0, index).split('\n').length;
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

      if (targetModule && targetModule !== fileModule && facaded.has(targetModule)
        && targetRel !== `${LIB}/${targetModule}/index.js`) {
        report(`import lib/${targetModule}/ through its facade, lib/${targetModule}/index.js`);
        continue;
      }

      if (fileModule && (STRICT_MANAGERS.includes(fileModule) || CARVED.includes(fileModule))) {
        if (targetModule === fileModule) continue;
        const isCarved = CARVED.includes(fileModule);
        if (targetModule && (isCarved ? CARVED : MANAGER_CARVED).includes(targetModule)) continue;
        if (isCarved && targetRel === `${LIB}/routeErrors.js`) {
          const names = (clause || '').replace(/[{}\s]/g, '').split(',').filter(Boolean);
          if (names.length > 0 && names.every((n) => n === 'createAppError')) continue;
          report('carved modules may import only createAppError from lib/routeErrors.js');
          continue;
        }
        report(isCarved
          ? `carved module lib/${fileModule}/ may import only its own files, the carved facades and createAppError`
          : `strict manager lib/${fileModule}/ may import only its own files and the mdns, networking and storage facades`);
      }
    }
  }

  for (const v of violations) console.error(v);
  const summary = `${count} imports across ${files.length} files`;
  if (violations.length > 0) {
    console.error(`\n${violations.length} fence violation(s) (${summary}).`);
    process.exit(1);
  }
  console.log(`OK — ${summary}, all inside their fences.`);
}

await main();
