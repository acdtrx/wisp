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
 * `export … from`, side-effect imports; inside a dynamic `import(…)`, every
 * string literal (the facades' platform ternaries, a package picked by a
 * condition) and a template literal's static prefix (`./linux/${name}.js`
 * checks as `./linux/`); `require(…)`, including through a `createRequire`
 * result. A specifier computed with no literal prefix can't be checked: it is a
 * violation unless EXCEPTIONS allows it.
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
const CREATE_REQUIRE_BINDING = /(?<![\w$.])(?:const|let|var)\s+([\w$]+)\s*=\s*(?:[\w$.]+\.)?createRequire\s*\(/g;
const CREATE_REQUIRE_DIRECT = /(?<![\w$.])(?:[\w$.]+\.)?createRequire\s*\([^()]*(?:\([^()]*\))*[^()]*\)\s*\(/g;

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
 * The specifiers a dynamic import()/require() argument can name: a whole literal;
 * else every string literal in it and each template literal's static prefix;
 * `<computed>` when it has neither.
 */
function specifiersOfArgument(arg) {
  const whole = /^(['"])([^'"\n]+)\1$/.exec(arg) || /^`([^`$]*)`$/.exec(arg);
  if (whole) return [whole[2] ?? whole[1]];
  const found = [];
  for (const lit of arg.matchAll(/(['"])([^'"\n]+)\1/g)) found.push(lit[2]);
  for (const tpl of arg.matchAll(/`([^`]*)`/g)) {
    const prefix = tpl[1].split('${')[0];
    if (/^\.\.?\//.test(prefix)) found.push(prefix);
    else if (prefix && !tpl[1].includes('${')) found.push(prefix);
  }
  return found.length > 0 ? found : ['<computed>'];
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
  const calls = [...code.matchAll(DYNAMIC_IMPORT), ...code.matchAll(REQUIRE_CALL), ...code.matchAll(CREATE_REQUIRE_DIRECT)];
  for (const b of code.matchAll(CREATE_REQUIRE_BINDING)) {
    const name = b[1].replace(/\$/g, '\\$');
    calls.push(...code.matchAll(new RegExp(`(?<![\\w$.])${name}\\s*\\(`, 'g')));
  }
  for (const m of calls) {
    for (const specifier of specifiersOfArgument(callArgument(code, m.index + m[0].length))) {
      found.push({ index: m.index, specifier, clause: null });
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
    for (const { index, specifier, clause } of importsOf(code)) {
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
      if (!specifier.startsWith('.')) {
        if (BUILTINS.has(specifier)) continue;
        const pkg = packageName(specifier);
        const allowed = PACKAGE_FENCES[pkg];
        if (allowed && !allowed.some((dir) => fileRel.startsWith(dir))) {
          report(`${pkg} may be imported only in ${allowed.join(', ')}`);
        }
        continue;
      }

      const targetRel = rel(path.resolve(path.dirname(file), specifier));
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
