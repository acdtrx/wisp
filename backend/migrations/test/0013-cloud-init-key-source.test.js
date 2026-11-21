/*
 * 0013 on a temporary VM directory, with the ctx the runner builds
 * (lib/stateMigrations.js, buildContext): it rewrites Wisp's own cloud-init.json
 * files and reaches no manager.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { run } from '../0013-cloud-init-key-source.js';

let vmsPath = null;

afterEach(() => {
  if (vmsPath) rmSync(path.dirname(vmsPath), { recursive: true, force: true });
  vmsPath = null;
});

/** VM directories, each with `files[name]` as its cloud-init.json (an object, or raw text; none when null). */
function vms(files) {
  vmsPath = path.join(mkdtempSync(path.join(tmpdir(), 'wisp-0013-test-')), 'vms');
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.join(vmsPath, name), { recursive: true });
    if (content == null) continue;
    writeFileSync(file(name), typeof content === 'string' ? content : JSON.stringify(content), { mode: 0o600 });
  }
}

const file = (name) => path.join(vmsPath, name, 'cloud-init.json');

function context() {
  const changes = [];
  const warnings = [];
  const log = { debug() {}, info() {}, error() {}, warn: (_f, m) => warnings.push(m), child() { return log; } };
  const unused = new Proxy({}, { get: (_t, key) => { throw new Error(`0013 reached the managers (${String(key)})`); } });
  return {
    changes,
    warnings,
    ctx: {
      log,
      vmManager: unused,
      containerManager: unused,
      getConfig: () => ({ vmsPath }),
      paths: {},
      setVMPendingRestart: () => { throw new Error('0013 set a restart flag'); },
      setContainerPendingRestart: () => { throw new Error('0013 set a restart flag'); },
      recordChange: (text) => changes.push(text),
    },
  };
}

const setup = { enabled: true, hostname: 'web', username: 'wisp', password: '***', passwordHash: '$6$x', sshKey: 'ssh-ed25519 AAAA me' };

test('each cloud-init.json loses sshKeySource and keeps the rest, still 0600', async () => {
  vms({ web: { ...setup, sshKeySource: 'github:me' }, db: { ...setup, sshKeySource: 'manual' }, bare: null });
  const { ctx, changes } = context();
  await run(ctx);
  assert.deepEqual(JSON.parse(readFileSync(file('web'), 'utf8')), setup);
  assert.deepEqual(JSON.parse(readFileSync(file('db'), 'utf8')), setup);
  assert.equal(statSync(file('web')).mode & 0o777, 0o600);
  assert.deepEqual(changes.sort(), ['db/cloud-init.json: sshKeySource removed', 'web/cloud-init.json: sshKeySource removed']);
});

test('a file without the field, or not JSON, is left alone; a second run changes nothing', async () => {
  vms({ web: setup, junk: '{not json' });
  const { ctx, changes, warnings } = context();
  await run(ctx);
  await run(ctx);
  assert.equal(readFileSync(file('junk'), 'utf8'), '{not json');
  assert.deepEqual(JSON.parse(readFileSync(file('web'), 'utf8')), setup);
  assert.deepEqual(changes, []);
  assert.equal(warnings.length, 2);
});

test('no VM directory yet is nothing to do', async () => {
  vms({});
  rmSync(vmsPath, { recursive: true, force: true });
  const { ctx, changes } = context();
  await run(ctx);
  assert.deepEqual(changes, []);
});
