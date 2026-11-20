#!/usr/bin/env node
/**
 * The backend's error codes, its one table of them (backend/src/lib/errorCodes.js)
 * and docs/specs/ERROR-HANDLING.md's list, kept in step: run with
 * `npm run check` (or `node scripts/check-error-codes.mjs`) from the repo root;
 * exits 1 when the code throws a code the table lacks, the table holds a code
 * nothing throws, or the table and the doc disagree (a code missing on either
 * side, or another status).
 *
 * A code thrown: an UPPER_SNAKE string literal given as the first argument of
 * an error factory (a call whose name ends in `Error`), or as `code: '…'`,
 * `code = '…'` or `.code = '…'`, outside comments; a constant
 * (`const BUSY = 'UPDATE_BUSY'`) passed to a factory counts as its value. In
 * lib/appErrors.js, which turns the framework's refusals into codes, every
 * UPPER_SNAKE literal counts. A code in the doc: the backticked code in the
 * first cell of a row of the code tables under its `## Codes` section, the status in the second (`—` for
 * the internal codes, which never reach a client).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DOC = 'docs/specs/ERROR-HANDLING.md';
const TABLE = 'backend/src/lib/errorCodes.js';
const CLASSIFIER = 'backend/src/lib/appErrors.js';
const CODE = '[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+';

const { ERROR_STATUS, INTERNAL_CODES } = await import(pathToFileURL(path.join(ROOT, TABLE)).href);

const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'backend/src'], {
  cwd: ROOT, encoding: 'utf8',
}).split('\0').filter((f) => f.endsWith('.js') && !f.endsWith('.test.js') && f !== TABLE);

/** The source without its comments; a `//` inside a word (a URL) stays. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[\s;{}(),])\/\/.*$/gm, '$1');
}

const thrown = new Map(); // code → first file:line
const unresolved = [];

function record(code, file, src, index) {
  if (thrown.has(code)) return;
  const line = src.slice(0, index).split('\n').length;
  thrown.set(code, `${file}:${line}`);
}

for (const file of files) {
  const src = stripComments(readFileSync(path.join(ROOT, file), 'utf8'));
  if (file === CLASSIFIER) {
    for (const m of src.matchAll(new RegExp(`'(${CODE})'`, 'g'))) record(m[1], file, src, m.index);
    continue;
  }
  const constants = new Map();
  for (const m of src.matchAll(new RegExp(`\\bconst ([A-Z_][A-Z0-9_]*) = '(${CODE})'`, 'g'))) constants.set(m[1], m[2]);
  for (const m of src.matchAll(new RegExp(`\\b\\w*Error\\(\\s*'(${CODE})'`, 'g'))) record(m[1], file, src, m.index);
  for (const m of src.matchAll(new RegExp(`(?:\\bcode\\s*[:=]|\\.code\\s*=)\\s*'(${CODE})'`, 'g'))) record(m[1], file, src, m.index);
  for (const m of src.matchAll(/\b(?:createAppError|vmError|containerError|networkingError)\(\s*([A-Z_][A-Z0-9_]*)\s*,/g)) {
    const value = constants.get(m[1]);
    if (value) record(value, file, src, m.index);
    else unresolved.push(`${file}:${src.slice(0, m.index).split('\n').length} ${m[1]}`);
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
for (const [code, where] of thrown) {
  if (ERROR_STATUS[code] === undefined && !INTERNAL_CODES.has(code)) {
    problems.push(`${code} is thrown (${where}) but is not in ${TABLE}`);
  }
}
for (const code of [...Object.keys(ERROR_STATUS), ...INTERNAL_CODES]) {
  if (!thrown.has(code)) problems.push(`${code} is in ${TABLE} but nothing throws it`);
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
for (const u of unresolved) problems.push(`an error factory is given a name that is not a code constant of its file: ${u}`);

if (problems.length > 0) {
  for (const p of problems) console.error(p);
  console.error(`\n${problems.length} problem(s) between the thrown codes, ${TABLE} and ${DOC}.`);
  process.exit(1);
}
console.log(`error codes: ${thrown.size} thrown, ${Object.keys(ERROR_STATUS).length} in the table, ${INTERNAL_CODES.size} internal, all in ${DOC}.`);
