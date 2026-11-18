#!/usr/bin/env node
/**
 * `bash -n` over every shell script in the repo: run with `npm run check` (or
 * `node scripts/check-shell.mjs`) from the repo root; exits 1 on any syntax error.
 *
 * A file is a shell script when its first line is a bash or sh shebang, or its
 * name ends in `.sh` (a sourced helper such as backend/scripts/wisp-port.sh has
 * no shebang). The files are git's: tracked plus untracked-but-not-ignored, so a
 * new script counts before it is committed, and nothing under an ignored
 * directory (node_modules, the vendored noVNC, .claude/worktrees) does.
 *
 * `bash -n` parses with the bash on PATH: bash 3.2 on macOS, bash 5 on the Linux
 * hosts and in CI. A failure prints that version, since bash 3.2 rejects some
 * syntax bash 5 accepts.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SHELL_SHEBANG = /^#!\s*\S*\/(?:env\s+)?(?:bash|sh)(?:\s|$)/;

function firstLine(file) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(128);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('utf8').split('\n')[0];
  } finally {
    closeSync(fd);
  }
}

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false; // listed by git but deleted in the working tree
  }
}

const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
}).split('\0').filter(Boolean);

const scripts = [...new Set(listed)]
  .filter((rel) => isFile(path.join(REPO_ROOT, rel)))
  .filter((rel) => rel.endsWith('.sh') || SHELL_SHEBANG.test(firstLine(path.join(REPO_ROOT, rel))))
  .sort();

const failures = [];
for (const rel of scripts) {
  const run = spawnSync('bash', ['-n', rel], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (run.error) {
    console.error(`could not run bash: ${run.error.message}`);
    process.exit(1);
  }
  if (run.status !== 0) failures.push({ rel, output: run.stderr.trim() || `bash -n exited ${run.status}` });
}

if (failures.length > 0) {
  for (const { output } of failures) console.error(output);
  const version = spawnSync('bash', ['-c', 'echo "$BASH_VERSION"'], { encoding: 'utf8' }).stdout.trim();
  console.error(`\n${failures.length} shell script(s) fail bash -n (bash ${version}, ${scripts.length} scripts checked).`);
  process.exit(1);
}
console.log(`OK — ${scripts.length} shell scripts parse with bash -n.`);
