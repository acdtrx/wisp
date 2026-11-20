#!/usr/bin/env node
/**
 * The backend's error codes, its one table of them (backend/src/lib/errorCodes.js)
 * and docs/specs/ERROR-HANDLING.md's list, kept in step: run with
 * `npm run check` (or `node scripts/check-error-codes.mjs`) from the repo root;
 * exits 1 when the code holds a code the table lacks, the table holds a code
 * the code never names, or the table and the doc disagree (a code missing on
 * either side, or another status).
 *
 * A code in the code: every UPPER_SNAKE string literal in backend/src (single-
 * or double-quoted, or a template literal without a substitution), outside
 * comments and tests, whatever it is passed to — an error factory of any name,
 * a variable, an object. It must be a code of the table, an internal code, or
 * one of the few names that are not codes (NOT_CODES: Linux capabilities,
 * seccomp architectures, Fastify's own error codes, environment variable
 * names). A code in the doc: the backticked code in the first cell of a row of
 * the code tables under its `## Codes` section, the status in the second (`—` for the internal codes, which
 * never reach a client).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DOC = 'docs/specs/ERROR-HANDLING.md';
const TABLE = 'backend/src/lib/errorCodes.js';
const CODE = '[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+';

/** UPPER_SNAKE names that are not error codes, by prefix. */
const NOT_CODES = [
  'CAP_', // Linux capabilities (container exec, the OCI spec)
  'SCMP_', // seccomp architectures and actions
  'FST_', // Fastify's and @fastify/multipart's own error codes, mapped to Wisp's
  'WISP_', // environment variable names
];

const { ERROR_STATUS, INTERNAL_CODES } = await import(pathToFileURL(path.join(ROOT, TABLE)).href);

const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'backend/src'], {
  cwd: ROOT, encoding: 'utf8',
}).split('\0').filter((f) => f.endsWith('.js') && !f.endsWith('.test.js') && f !== TABLE);

/** The source without its comments; a `//` inside a word (a URL) stays. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[\s;{}(),])\/\/.*$/gm, '$1');
}

const named = new Map(); // code → first file:line
for (const file of files) {
  const src = stripComments(readFileSync(path.join(ROOT, file), 'utf8'));
  for (const m of src.matchAll(new RegExp(`(['"\`])(${CODE})\\1`, 'g'))) {
    const code = m[2];
    if (NOT_CODES.some((prefix) => code.startsWith(prefix)) || named.has(code)) continue;
    named.set(code, `${file}:${src.slice(0, m.index).split('\n').length}`);
  }
}

const docRows = new Map(); // code → status text
const docFull = readFileSync(path.join(ROOT, DOC), 'utf8');
// The code tables live under `## Codes`, up to the next section; other tables
// (the client's own codes, the framework's refusals) name codes too.
const codesStart = docFull.indexOf('\n## Codes\n');
if (codesStart === -1) {
  console.error(`${DOC} has no "## Codes" section.`);
  process.exit(1);
}
const codesEnd = docFull.indexOf('\n## ', codesStart + 1);
const docText = docFull.slice(codesStart, codesEnd === -1 ? undefined : codesEnd);
for (const m of docText.matchAll(new RegExp(`^\\|\\s*\`(${CODE})\`\\s*\\|\\s*([^|]+?)\\s*\\|`, 'gm'))) {
  docRows.set(m[1], m[2]);
}

const problems = [];
for (const [code, where] of named) {
  if (ERROR_STATUS[code] === undefined && !INTERNAL_CODES.has(code)) {
    problems.push(`${code} is in the code (${where}) but is not in ${TABLE}, nor a name NOT_CODES allows`);
  }
}
for (const code of [...Object.keys(ERROR_STATUS), ...INTERNAL_CODES]) {
  if (!named.has(code)) problems.push(`${code} is in ${TABLE} but the code never names it`);
}
for (const [code, status] of Object.entries(ERROR_STATUS)) {
  if (!docRows.has(code)) problems.push(`${code} (${status}) is in ${TABLE} but has no row in ${DOC}`);
  else if (docRows.get(code) !== String(status)) {
    problems.push(`${code} answers ${status} in ${TABLE}, but ${DOC} says ${docRows.get(code)}`);
  }
}
for (const code of INTERNAL_CODES) {
  if (!docRows.has(code)) problems.push(`${code} (internal) has no row in ${DOC}`);
  else if (docRows.get(code) !== '—') problems.push(`${code} is internal in ${TABLE}, but ${DOC} gives it a status`);
}
for (const code of docRows.keys()) {
  if (ERROR_STATUS[code] === undefined && !INTERNAL_CODES.has(code)) problems.push(`${code} has a row in ${DOC} but is not in ${TABLE}`);
}

if (problems.length > 0) {
  for (const p of problems) console.error(p);
  console.error(`\n${problems.length} problem(s) between the codes in the code, ${TABLE} and ${DOC}.`);
  process.exit(1);
}
console.log(`error codes: ${named.size} named in the code, ${Object.keys(ERROR_STATUS).length} in the table, ${INTERNAL_CODES.size} internal, all in ${DOC}.`);
