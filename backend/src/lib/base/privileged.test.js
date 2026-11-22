/*
 * The one privileged runner, against a stand-in sudo (first on PATH) that runs
 * the command — or refuses it as sudo does, for a command named refuse-me.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runPrivileged, helperPath, PrivilegedError } from './privileged.js';

let dir;
let savedPath;
const script = (name, body) => {
  const p = path.join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
};

before(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'wisp-privileged-'));
  script('sudo', [
    '[ "$1" = "-n" ] || { echo "sudo: expected -n" >&2; exit 2; }',
    'shift',
    'case "$1" in *refuse-me) echo "sudo: a password is required" >&2; exit 1;; esac',
    'case "$1" in *denied) echo "Sorry, user wisp is not allowed to execute $1 as root on host." >&2; exit 1;; esac',
    'exec "$@"',
  ].join('\n'));
  savedPath = process.env.PATH;
  process.env.PATH = `${dir}:${savedPath}`;
});
after(() => {
  process.env.PATH = savedPath;
  rmSync(dir, { recursive: true, force: true });
});

const reason = (p) => p.then(() => 'ok', (err) => (err instanceof PrivilegedError ? err.reason : `other: ${err.message}`));

test('a helper is found under /usr/local/bin', () => {
  assert.equal(helperPath('wisp-mount'), '/usr/local/bin/wisp-mount');
});

test('the command runs through sudo -n with LC_ALL=C, its output answered', async () => {
  const cmd = script('say', 'echo "out $1 $LC_ALL"; echo err >&2');
  assert.deepEqual(await runPrivileged(cmd, ['a'], { timeoutMs: 5000 }), { stdout: 'out a C\n', stderr: 'err\n' });
});

test('missing, refused, failed and timed out are told apart', async () => {
  assert.equal(await reason(runPrivileged(path.join(dir, 'nope'), [], { timeoutMs: 5000 })), 'missing');
  assert.equal(await reason(runPrivileged(script('refuse-me', 'echo never'), [], { timeoutMs: 5000 })), 'refused');
  assert.equal(await reason(runPrivileged(script('denied', 'echo never'), [], { timeoutMs: 5000 })), 'refused');
  const failing = script('fails', 'echo "src not found" >&2; exit 2');
  const err = await runPrivileged(failing, [], { timeoutMs: 5000 }).catch((e) => e);
  assert.deepEqual([err.reason, err.exitCode, err.detail], ['failed', 2, 'src not found']);
  // A command that exits 1 with stderr of its own is its own failure, not a refusal.
  assert.equal(await reason(runPrivileged(script('one', 'echo "no such disk" >&2; exit 1'), [], { timeoutMs: 5000 })), 'failed');
  assert.equal(await reason(runPrivileged(script('slow', 'sleep 5'), [], { timeoutMs: 100, graceMs: 100 })), 'timed-out');
});

test('a stall bound, an abort and the output lines', async () => {
  assert.equal(await reason(runPrivileged(script('quiet', 'echo one; sleep 5'), [], { stallMs: 200, graceMs: 100 })), 'timed-out');
  const ac = new AbortController();
  const lines = [];
  const run = runPrivileged(script('talks', 'echo "step 1" >&2; sleep 5'), [], { stallMs: 5000, signal: ac.signal, onStderrLine: (l) => { lines.push(l); ac.abort(); } });
  assert.equal(await reason(run), 'aborted');
  assert.deepEqual(lines, ['step 1']);
});

test('a time bound is required', async () => {
  await assert.rejects(runPrivileged('/bin/true', []), TypeError);
});
