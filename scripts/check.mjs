#!/usr/bin/env node
/**
 * `npm run check` from the repo root: every check, one after the other, each
 * with its own output. Exits 1 when any of them failed, after running them all,
 * so one run lists every problem.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

/** `needs`: the package directory whose installed dependencies the check runs on. */
const CHECKS = [
  { name: 'imports', command: ['node', 'scripts/check-imports.mjs'] },
  { name: 'fences', command: ['node', 'scripts/check-fences.mjs'] },
  { name: 'shell', command: ['node', 'scripts/check-shell.mjs'] },
  { name: 'test', command: ['npm', 'test', '--silent'], needs: 'frontend' },
];

const failed = [];
for (const { name, command, needs } of CHECKS) {
  console.log(`\n── ${name} ──`);
  if (needs && !existsSync(path.join(REPO_ROOT, needs, 'node_modules'))) {
    console.error(`${needs}/node_modules is missing: run \`npm ci\` in ${needs}/ first.`);
    failed.push(name);
    continue;
  }
  const [bin, ...args] = command;
  const run = spawnSync(bin === 'node' ? process.execPath : bin, args, { cwd: REPO_ROOT, stdio: 'inherit' });
  if (run.error) console.error(`could not run ${command.join(' ')}: ${run.error.message}`);
  if (run.status !== 0) failed.push(name);
}

console.log('');
if (failed.length > 0) {
  console.error(`check failed: ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`check passed: ${CHECKS.map((c) => c.name).join(', ')}`);
