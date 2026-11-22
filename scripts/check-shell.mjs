#!/usr/bin/env node
/**
 * `bash -n`, then shellcheck, over every shell script in the repo: run with
 * `npm run check` (or `node scripts/check-shell.mjs`) from the repo root; exits
 * 1 on any syntax error or finding, and when shellcheck is not installed (it is
 * required, never skipped).
 *
 * A file is a shell script when its first line is a bash or sh shebang, or its
 * name ends in `.sh` (a sourced file such as scripts/linux/setup/lib.sh has
 * no shebang). The files are git's: tracked plus untracked-but-not-ignored, so a
 * new script counts before it is committed, and nothing under an ignored
 * directory (node_modules, the vendored noVNC, .claude/worktrees) does.
 *
 * `bash -n` parses with the bash on PATH: bash 3.2 on macOS, bash 5 on the Linux
 * hosts and in CI. A failure prints that version, since bash 3.2 rejects some
 * syntax bash 5 accepts.
 *
 * shellcheck reads the repo's `.shellcheckrc`, which disables nothing. An
 * inline `# shellcheck disable=` fails the check, as an inline ESLint comment
 * does: an allowance is a reviewed line in EXCEPTIONS below, for one file and
 * one code. The `shell=` and `source=` directives, which only inform it, stay.
 *
 * How a script is used, held by its mode and its first line: one that starts
 * with a shebang is run by path, so git holds it 100755; one without is
 * sourced, so it is 100644 and starts with `# shellcheck shell=bash`. A
 * tracked file's mode is git's, an untracked one's the file's own.
 *
 * And the helpers folder holds only helpers (docs/specs/DEPLOYMENT.md,
 * Privileged helpers): every file directly in backend/scripts/ is a
 * `wisp-<name>` that starts with a bash shebang (a helper, or the updater) or
 * the one shared file, wisp-helper-lib.sh. Setup installs every such script as
 * a root command with a sudo rule, so nothing else may sit there, but for the
 * reviewed files in NOT_HELPERS.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { openSync, readSync, closeSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

/** Reviewed allowances: shellcheck's `code` is not run on `file`, for `why`. */
const EXCEPTIONS = [
  { file: 'backend/scripts/wisp-helper-lib.sh', code: 'SC2034', why: 'its limits, patterns and answers are read by the helpers that source it' },
  { file: 'scripts/linux/setup/bounds.sh', code: 'SC2034', why: 'it only holds the bounds the scripts that source it read' },
  { file: 'scripts/linux/setup/lib.sh', code: 'SC2034', why: 'WISP_LOCK and SETUP_PYTHON are read by the scripts that source it' },
  { file: 'scripts/linux/setup/install-state.sh', code: 'SC2034', why: 'PASSWORD_RULE is read by the scripts that source it' },
  { file: 'scripts/linux/setup/container-dns-plan.sh', code: 'SC2034', why: 'DNS_STUB_PLANNED is read by the scripts that source it' },
  { file: 'scripts/linux/setup/network-plan.sh', code: 'SC2034', why: 'HOST_KVM is written to the plan record by name (plan-record.sh)' },
  { file: 'scripts/linux/setup/bridge-plan.sh', code: 'SC2153', why: 'NET_PLAN_DIR is set by the scripts that source it' },
  { file: 'scripts/linux/setup/bridge.sh', code: 'SC2329', why: 'read_now, read_uplink and undo_stopped run by name (step_run, STEP_ON_STOP)' },
  { file: 'scripts/linux/install-root.sh', code: 'SC2094', why: 'the log is the worker\'s argument and its output both, never read here' },
  { file: 'scripts/linux/setup/config.sh', code: 'SC2016', why: 'a node -e program, which the shell must not expand' },
  { file: 'scripts/linux/setup/password.sh', code: 'SC2016', why: 'a node -e program, which the shell must not expand' },
  { file: 'scripts/release.sh', code: 'SC2016', why: 'a node -e program, which the shell must not expand' },
  { file: 'backend/scripts/wisp-updater', code: 'SC2016', why: 'a sh -c program, its values passed as arguments' },
  { file: 'backend/scripts/wisp-updater', code: 'SC2329', why: 'rollback runs from the EXIT trap' },
];
const INLINE_DISABLE = /#\s*shellcheck\s+(?:\S+\s+)*disable=/;
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

const problems = [];

const SOURCED_FIRST_LINE = '# shellcheck shell=bash';
const trackedModes = new Map(
  execFileSync('git', ['ls-files', '-z', '-s'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\0').filter(Boolean)
    .map((entry) => {
      const [meta, file] = entry.split('\t');
      return [file, meta.split(' ')[0]];
    }),
);
const modeOf = (rel) => trackedModes.get(rel)
  ?? ((statSync(path.join(REPO_ROOT, rel)).mode & 0o111) ? '100755' : '100644');
for (const rel of scripts) {
  const first = firstLine(path.join(REPO_ROOT, rel));
  const mode = modeOf(rel);
  if (SHELL_SHEBANG.test(first)) {
    if (mode !== '100755') problems.push(`${rel}: starts with a shebang, so it is run by path and must be 100755 (it is ${mode}): git update-index --chmod=+x ${rel}`);
  } else if (first !== SOURCED_FIRST_LINE) {
    problems.push(`${rel}: has no shebang, so it is sourced and must start with "${SOURCED_FIRST_LINE}"`);
  } else if (mode !== '100644') {
    problems.push(`${rel}: is sourced (no shebang), so it must be 100644 (it is ${mode}): git update-index --chmod=-x ${rel}`);
  }
}

const HELPERS_DIR = 'backend/scripts/';
const HELPER_LIB = `${HELPERS_DIR}wisp-helper-lib.sh`;
/** Reviewed files of the helpers folder that are no helper (setup installs none of them), with why. */
const NOT_HELPERS = [
  {
    file: `${HELPERS_DIR}wisp-port.sh`,
    why: 'the updater of releases up to v2.8.0-beta.1 sources it from the tree it installs, at this path',
  },
];
const BASH_SHEBANG = /^#!\s*\S*\/(?:env\s+)?bash(?:\s|$)/;
for (const rel of [...new Set(listed)]) {
  if (!rel.startsWith(HELPERS_DIR) || rel.slice(HELPERS_DIR.length).includes('/')) continue;
  if (rel === HELPER_LIB || NOT_HELPERS.some((n) => n.file === rel) || !isFile(path.join(REPO_ROOT, rel))) continue;
  const name = rel.slice(HELPERS_DIR.length);
  if (!/^wisp-[a-z0-9-]+$/.test(name) || !BASH_SHEBANG.test(firstLine(path.join(REPO_ROOT, rel)))) {
    problems.push(`${rel}: the helpers folder holds only wisp-<name> scripts that start with a bash shebang, and ${HELPER_LIB}: setup installs each as a root command with a sudo rule`);
  }
}
for (const rel of scripts) {
  readFileSync(path.join(REPO_ROOT, rel), 'utf8').split('\n').forEach((line, i) => {
    if (INLINE_DISABLE.test(line)) problems.push(`${rel}:${i + 1}: an inline shellcheck disable; add a reviewed line to EXCEPTIONS in scripts/check-shell.mjs instead`);
  });
}
for (const { file } of NOT_HELPERS) {
  if (!listed.includes(file)) problems.push(`scripts/check-shell.mjs: NOT_HELPERS names ${file}, which is not here`);
}
for (const { file } of EXCEPTIONS) {
  if (!scripts.includes(file)) problems.push(`scripts/check-shell.mjs: EXCEPTIONS names ${file}, which is not a shell script here`);
}

/** One run per set of excluded codes: the files without any in one run. */
const runs = new Map();
for (const rel of scripts) {
  const codes = EXCEPTIONS.filter((e) => e.file === rel).map((e) => e.code).sort().join(',');
  if (!runs.has(codes)) runs.set(codes, []);
  runs.get(codes).push(rel);
}
let findings = '';
for (const [codes, files] of runs) {
  const run = spawnSync('shellcheck', [...(codes ? ['--exclude', codes] : []), '--format', 'gcc', ...files], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (run.error) {
    console.error(run.error.code === 'ENOENT'
      ? 'shellcheck is not installed, and the check needs it: install it (brew install shellcheck, apt install shellcheck).'
      : `could not run shellcheck: ${run.error.message}`);
    process.exit(1);
  }
  if (run.status !== 0) findings += run.stdout || run.stderr || `shellcheck exited ${run.status}\n`;
}
if (findings) problems.push(findings.trimEnd());

if (problems.length > 0) {
  for (const p of problems) console.error(p);
  const version = spawnSync('shellcheck', ['--version'], { encoding: 'utf8' }).stdout.match(/version: (\S+)/)?.[1];
  console.error(`\nThe shell check fails (${scripts.length} shell scripts; shellcheck ${version ?? '(version unknown)'}).`);
  process.exit(1);
}
console.log(`OK — ${scripts.length} shell scripts parse with bash -n, pass shellcheck, and have the mode their use needs; the helpers folder holds only helpers.`);
