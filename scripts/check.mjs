#!/usr/bin/env node
/**
 * `npm run check` from the repo root: every check, one after the other, each
 * with its own output. Exits 1 when any of them failed, after running them all,
 * so one run lists every problem.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

const CHECKS = [
  { name: 'imports', command: ['node', 'scripts/check-imports.mjs'] },
  { name: 'fences', command: ['node', 'scripts/check-fences.mjs'] },
  { name: 'shell', command: ['node', 'scripts/check-shell.mjs'] },
];

const failed = [];
for (const { name, command } of CHECKS) {
  console.log(`\n── ${name} ──`);
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
