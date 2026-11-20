/*
 * 0009 run on a temporary install directory, with the ctx the runner builds
 * (lib/stateMigrations.js, buildContext): this migration reads and writes
 * config/backup-status.json itself and touches no manager.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { run } from '../0009-backup-status-error-code.js';

let installDir = null;

function removeInstall() {
  if (installDir) rmSync(installDir, { recursive: true, force: true });
  installDir = null;
}

afterEach(removeInstall);

/** A fresh install directory, `status` (an object, or raw text) as its backup-status.json; none when undefined. */
function install(status) {
  removeInstall();
  installDir = mkdtempSync(path.join(tmpdir(), 'wisp-0009-test-'));
  mkdirSync(path.join(installDir, 'config'));
  if (status !== undefined) {
    writeFileSync(statusPath(), typeof status === 'string' ? status : JSON.stringify(status));
  }
}

const statusPath = () => path.join(installDir, 'config', 'backup-status.json');
const readStatus = () => JSON.parse(readFileSync(statusPath(), 'utf8'));

/** The ctx the runner gives a migration, its changes and warnings recorded. */
function context() {
  const changes = [];
  const warnings = [];
  const log = {
    debug() {}, info() {}, error() {},
    warn: (fields, message) => warnings.push(message),
    child() { return log; },
  };
  const unused = new Proxy({}, { get: (_t, key) => { throw new Error(`0009 reached the managers (${String(key)})`); } });
  const configDir = path.join(installDir, 'config');
  return {
    changes,
    warnings,
    ctx: {
      log,
      vmManager: unused,
      containerManager: unused,
      getConfig: () => { throw new Error('0009 read the config'); },
      paths: {
        installDir, configDir, configFile: path.join(configDir, 'wisp-config.json'), runtimeEnvFile: path.join(configDir, 'runtime.env'),
      },
      setVMPendingRestart: () => { throw new Error('0009 set a restart flag'); },
      setContainerPendingRestart: () => { throw new Error('0009 set a restart flag'); },
      recordChange: (text) => changes.push(text),
    },
  };
}

const ok = { at: '2026-11-01T03:00:00.000Z', ok: true, origin: 'scheduled', destinationIds: ['local'], timestamp: '2026-11-01T03-00-00' };
const failed = (fields) => ({ at: '2026-11-02T03:00:00.000Z', ok: false, origin: 'manual', destinationIds: ['local'], ...fields });

test('a failed record holding a message gets it as its detail and INTERNAL_ERROR as its error', async () => {
  install({ vms: { web: failed({ error: 'Backup failed: disk full' }) }, containers: { db: ok } });
  const { ctx, changes } = context();
  await run(ctx);
  assert.deepEqual(readStatus(), {
    vms: { web: failed({ error: 'INTERNAL_ERROR', detail: 'Backup failed: disk full' }) },
    containers: { db: ok },
  });
  assert.deepEqual(changes, ['backup-status.json vms.web: error message → detail, error INTERNAL_ERROR']);
});

test('successful and already-migrated records are left alone, and nothing is written', async () => {
  const status = {
    vms: { web: ok },
    containers: { db: failed({ error: 'BACKUP_DESTINATION_UNAVAILABLE', detail: 'Destination "nas" is not mounted' }) },
  };
  install(status);
  const { ctx, changes } = context();
  await run(ctx);
  assert.deepEqual(readStatus(), status);
  assert.deepEqual(changes, []);
});

test('a failed record without a message is left alone', async () => {
  const status = { vms: { web: failed({}) }, containers: { db: failed({ error: null }) } };
  install(status);
  const { ctx, changes } = context();
  await run(ctx);
  assert.deepEqual(readStatus(), status);
  assert.deepEqual(changes, []);
});

test('a missing file is no attempt recorded: nothing is written', async () => {
  install(undefined);
  const { ctx, changes } = context();
  await run(ctx);
  assert.equal(existsSync(statusPath()), false);
  assert.deepEqual(changes, []);
});

test('a file that is not a JSON object is left for the backend to replace, with a warning', async () => {
  for (const text of ['not json', '[]', 'null', '"x"']) {
    install(text);
    const { ctx, changes, warnings } = context();
    await run(ctx);
    assert.equal(readFileSync(statusPath(), 'utf8'), text, text);
    assert.deepEqual(changes, [], text);
    assert.equal(warnings.length, 1, text);
  }
});

test('a second run changes nothing', async () => {
  install({ vms: { web: failed({ error: 'Backup failed: disk full' }) }, containers: {} });
  await run(context().ctx);
  const once = readFileSync(statusPath(), 'utf8');
  const { ctx, changes } = context();
  await run(ctx);
  assert.equal(readFileSync(statusPath(), 'utf8'), once);
  assert.deepEqual(changes, []);
});
