#!/usr/bin/env node
/**
 * Setup's refusals and docs/specs/DEPLOYMENT.md's tables of them, kept in step:
 * run with `npm run check` (or `node scripts/check-refusals.mjs`) from the repo
 * root; exits 1 when a code the scripts can print has no row, or a row names a
 * code no script prints.
 *
 * A code in the scripts (scripts/linux/): the first argument of `refuse` or
 * `net_refuse` (scripts/linux/setup/lib.sh, bridge-plan.sh), an `ERROR CODE:`
 * written out, or the code a DHCP_ID_REFUSAL starts with. A code in the doc:
 * each code in backticks in the first cell of a table row.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DOC = 'docs/specs/DEPLOYMENT.md';
const CODE = '[A-Z][A-Z0-9_]+';
const PATTERNS = [
  new RegExp(`\\b(?:net_)?refuse (${CODE})\\b`, 'g'),
  new RegExp(`ERROR (${CODE}):`, 'g'),
  new RegExp(`DHCP_ID_REFUSAL="(${CODE}) `, 'g'),
];

const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'scripts/linux'], {
  cwd: ROOT, encoding: 'utf8',
}).split('\0').filter((f) => f.endsWith('.sh'));

const inCode = new Map();
for (const rel of files) {
  let text;
  try {
    text = readFileSync(path.join(ROOT, rel), 'utf8');
  } catch {
    continue; // listed by git but deleted in the working tree
  }
  for (const line of text.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    for (const re of PATTERNS) {
      for (const m of line.matchAll(re)) {
        if (!inCode.has(m[1])) inCode.set(m[1], rel);
      }
    }
  }
}

const inDoc = new Set();
for (const line of readFileSync(path.join(ROOT, DOC), 'utf8').split('\n')) {
  const cell = line.match(/^\| ([^|]+) \|/);
  if (!cell) continue;
  for (const m of cell[1].matchAll(new RegExp(`\`(${CODE})\``, 'g'))) inDoc.add(m[1]);
}

const problems = [];
for (const [code, rel] of [...inCode].sort()) {
  if (!inDoc.has(code)) problems.push(`${rel} refuses with ${code}, which ${DOC} has no row for`);
}
for (const code of [...inDoc].sort()) {
  if (!inCode.has(code)) problems.push(`${DOC} has a row for ${code}, which no script under scripts/linux prints`);
}
if (problems.length > 0) {
  for (const p of problems) console.error(p);
  process.exit(1);
}
console.log(`refusals: ${inCode.size} codes, each with its row in ${DOC}`);
