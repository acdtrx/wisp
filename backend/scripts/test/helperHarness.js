/*
 * Runs a privileged helper from this tree, without root, against stand-in
 * commands: PATH holds only the stand-ins, so a command the helper runs is
 * either a stand-in, which records its call, or not found (exit 127). A
 * refusal (CODING-RULES §12) is exit 64, one line on stderr naming the
 * helper, nothing on stdout, and no command run.
 */
import { spawnSync, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = fileURLToPath(new URL('../', import.meta.url));
const BASH = execFileSync('/bin/sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim();

/** Commands the helpers act with: each stood in by one that records its call and succeeds. */
const STOOD_IN = ['apt-get', 'chown', 'cp', 'dmidecode', 'ip', 'mkdir', 'mkfifo', 'mount', 'mv', 'netplan', 'realpath',
  'rmdir', 'shutdown', 'sleep', 'smartctl', 'stat', 'sync', 'umount'];
/** Text and temp-file tools: recorded, then the real one runs. */
const PASSED_THROUGH = ['awk', 'cat', 'grep', 'head', 'mktemp', 'rm', 'sed', 'tail', 'tr'];
/** `timeout <grace> <secs> cmd…` stood in by running cmd (a stand-in itself). */
const TIMEOUT = 'shift 2; exec "$@"';
const realPath = (name) => execFileSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim();

/**
 * A stand-in environment for one test file. `standIns` overrides a command's
 * stand-in with a shell body of its own (it still records its call).
 */
export function helperBench() {
  const dir = mkdtempSync(path.join(tmpdir(), 'wisp-helper-test-'));
  const bin = path.join(dir, 'bin');
  const log = path.join(dir, 'calls');
  execFileSync('/bin/mkdir', [bin]);

  const standIn = (name, body = 'exit 0') => {
    const p = path.join(bin, name);
    writeFileSync(p, `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> '${log}'\n${body}\n`);
    chmodSync(p, 0o755);
  };
  const defaults = {};
  for (const name of STOOD_IN) defaults[name] = 'exit 0';
  for (const name of PASSED_THROUGH) defaults[name] = `exec '${realPath(name)}' "$@"`;
  defaults.timeout = TIMEOUT;
  for (const [name, body] of Object.entries(defaults)) standIn(name, body);

  /** Run `helper` with `args`: `{ code, stdout, stderr, calls }`. */
  function run(helper, args, { standIns = {}, env = {} } = {}) {
    for (const [name, body] of Object.entries(standIns)) standIn(name, body);
    rmSync(log, { force: true });
    const res = spawnSync(BASH, [path.join(SCRIPTS_DIR, helper), ...args], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { PATH: bin, SUDO_UID: String(process.getuid()), SUDO_GID: String(process.getgid()), ...env },
    });
    for (const name of Object.keys(standIns)) standIn(name, defaults[name]);
    const calls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
    return { code: res.status, stdout: res.stdout, stderr: res.stderr, calls };
  }

  /** Asserts that `helper args` is refused before it runs anything. */
  function assertRefused(helper, args, opts) {
    const r = run(helper, args, opts);
    const what = `${helper} ${args.map((a) => JSON.stringify(a)).join(' ')}`;
    assert.equal(r.code, 64, `${what}: exit ${r.code}, stderr ${JSON.stringify(r.stderr)}`);
    assert.equal(r.stdout, '', `${what}: printed on stdout`);
    const lines = r.stderr.split('\n').filter(Boolean);
    assert.equal(lines.length, 1, `${what}: stderr is not one line: ${JSON.stringify(r.stderr)}`);
    assert.ok(lines[0].startsWith(`${helper}: `), `${what}: the error line does not name the helper: ${lines[0]}`);
    assert.deepEqual(r.calls, [], `${what}: ran a command before refusing`);
  }

  return { dir, run, assertRefused, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
