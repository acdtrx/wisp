#!/usr/bin/env node
/**
 * `npm run check` from the repo root: every check, one after the other, each
 * with its own output. Exits 1 when any of them failed, after running them all,
 * so one run lists every problem.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

/**
 * `needs`: the package directory (`.` for the repo root) whose installed
 * dependencies the check runs on.
 * `timeoutMs`: a bound on the whole step. The test runner ends a test that runs
 * too long, but a test file whose test left a timer or stream open never exits,
 * and the run would wait for it forever.
 */
const CHECKS = [
  { name: 'imports', command: ['node', 'scripts/check-imports.mjs'] },
  { name: 'fences', command: ['node', 'scripts/check-fences.mjs'] },
  { name: 'lint', command: ['npm', 'run', 'lint', '--silent'], needs: '.' },
  { name: 'shell', command: ['node', 'scripts/check-shell.mjs'] },
  { name: 'bounds', command: ['node', 'scripts/check-bounds.mjs'] },
  { name: 'refusals', command: ['node', 'scripts/check-refusals.mjs'] },
  { name: 'journal-format', command: ['node', 'scripts/check-journal-format.mjs'] },
  // Setup's Python, which reads the network tools' files: its unit tests.
  { name: 'setup-python', command: ['python3', '-I', '-B', '-m', 'unittest', 'discover', '-s', 'scripts/linux/setup', '-p', '*_test.py'], timeoutMs: 60_000 },
  { name: 'test', command: ['npm', 'test', '--silent'], needs: 'frontend', timeoutMs: 120_000 },
];

/** The running step's process group, ended with the runner. */
let running = null;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (running) process.kill(-running.pid, 'SIGKILL');
    process.exit(1);
  });
}

/** Run one step in a process group of its own; resolves `{ ok, timedOut }`. */
function runStep(command, timeoutMs) {
  const [bin, ...args] = command;
  return new Promise((resolve) => {
    const child = spawn(bin === 'node' ? process.execPath : bin, args, {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      detached: true, // its own group, so a bound ends every process it started
    });
    running = child;
    let timedOut = false;
    const timer = timeoutMs && setTimeout(() => {
      timedOut = true;
      process.kill(-child.pid, 'SIGKILL');
    }, timeoutMs);
    child.on('error', (err) => {
      console.error(`could not run ${command.join(' ')}: ${err.message}`);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      running = null;
      resolve({ ok: code === 0 && !timedOut, timedOut });
    });
  });
}

const failed = [];
for (const { name, command, needs, timeoutMs } of CHECKS) {
  console.log(`\n── ${name} ──`);
  if (needs && !existsSync(path.join(REPO_ROOT, needs, 'node_modules'))) {
    const where = needs === '.' ? 'at the repo root' : `in ${needs}/`;
    console.error(`${needs === '.' ? '' : `${needs}/`}node_modules is missing: run \`npm ci\` ${where} first.`);
    failed.push(name);
    continue;
  }
  const { ok, timedOut } = await runStep(command, timeoutMs);
  if (timedOut) {
    console.error(`\n${name} did not finish within ${timeoutMs / 1000} s and was stopped: `
      + 'a test probably left a timer or stream open.');
  }
  if (!ok) failed.push(name);
}

console.log('');
if (failed.length > 0) {
  console.error(`check failed: ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`check passed: ${CHECKS.map((c) => c.name).join(', ')}`);
