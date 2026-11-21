/*
 * Restore planning against a backup on disk and a stand-in libvirt with no domains:
 * a backup made before VM profiles is refused before anything is created.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { connectionState } from './vmManagerConnection.js';
import { setVmManagerPaths } from './vmManagerPaths.js';
import { planBackupRestore } from './vmManagerBackup.js';

let root;

/** A backup directory holding a manifest and the domain XML (no disks). */
function backup(name, metadata) {
  const dir = path.join(root, 'backups', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ vmName: name, timestamp: '20261101-000000' }));
  writeFileSync(path.join(dir, 'domain.xml'), `<domain type="kvm"><name>${name}</name>${metadata}<devices><interface type="bridge"><mac address="52:54:00:00:00:01"/><source bridge="br0"/></interface></devices></domain>`);
  return dir;
}

before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'wisp-restore-test-'));
  setVmManagerPaths({ vmsPath: path.join(root, 'vms') });
  connectionState.connectIface = { DomainLookupByName: async () => { throw new Error('Domain not found'); } };
});
after(() => rmSync(root, { recursive: true, force: true }));

test('a backup made before profiles is refused, and nothing is created', async () => {
  const dir = backup('old', '');
  await assert.rejects(
    planBackupRestore(dir, 'old-copy'),
    (err) => err.code === 'BACKUP_INVALID' && /before VM profiles/.test(err.message),
  );
  assert.equal(existsSync(path.join(root, 'vms', 'old-copy')), false);
});

test('a backup with a profile is planned, the profile kept', async () => {
  const dir = backup('new', '<metadata><wisp:prefs xmlns:wisp="https://wisp.local/app"><wisp:profile>other</wisp:profile></wisp:prefs></metadata>');
  const plan = await planBackupRestore(dir, 'new-copy');
  try {
    assert.match(plan.newXml, /<wisp:profile>other<\/wisp:profile>/);
    assert.match(plan.newXml, /<name>new-copy<\/name>/);
  } finally {
    await plan.payload.close();
  }
});
