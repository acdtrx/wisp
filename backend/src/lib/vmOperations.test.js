/*
 * The VM commands with the manager, cloud-init, the path policy and the
 * follow-ups' stores mocked (node --test --experimental-test-module-mocks):
 * the lock, the job starter and the follow-up orchestration are the real
 * ones. Every mocked call is recorded in `calls`, in order; a test sets what
 * a mocked function does in `impl`.
 */
import { beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';

import { createAppError } from './appErrors.js';

const calls = [];
const impl = {};

/** Named exports that record each call and answer what `impl` says (undefined by default). */
function recorded(names) {
  return Object.fromEntries(names.map((name) => [name, (...args) => {
    calls.push([name, ...args]);
    return impl[name]?.(...args);
  }]));
}

const mockModule = (path, names) => mock.module(new URL(path, import.meta.url).href, { namedExports: recorded(names) });

mockModule('./vmManager/index.js', [
  'assertVMNameAvailable', 'createVM', 'assertVMState', 'startVM', 'stopVM', 'forceStopVM', 'rebootVM', 'suspendVM',
  'resumeVM', 'deleteVM', 'updateVMConfig', 'renameVM', 'attachDisk', 'createAndAttachDisk', 'detachDisk', 'resizeDiskBySlot',
  'attachISO', 'ejectISO', 'attachUSBDevice', 'detachUSBDevice', 'createBackup', 'listVMs',
  'isShutOff', 'planBackupRestore', 'restoreBackup', 'getVMConfig',
]);
mockModule('./cloudInit.js', ['generateCloudInit', 'rebuildCloudInitISO', 'updateCloudInit', 'detachCloudInitDisk']);
mockModule('./paths.js', ['isPathInsideAllowedRoots']);
mockModule('./backupDestinations.js', ['resolveBackupDestinations', 'backupToEachDestination']);
mockModule('./backupStatus.js', ['recordBackupAttempt', 'moveBackupStatus', 'forgetBackupStatus']);
mockModule('./sections.js', ['renameWorkloadAssignment', 'removeWorkloadAssignment']);
mockModule('./containerMdnsReconciler.js', ['publishContainer', 'unpublishContainer']);

const { editVmConfig, saveVmCloudInit, startVmCreateJob, startVmDeleteJob } = await import('./vmOperations.js');
const { whenJobEnds } = await import('./jobs/index.js');
const { acquireVmOperationLock } = await import('./vmOperationLock.js');

const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return log; } };

/** The recorded calls by function name, in order. */
const names = () => calls.map(([name]) => name);

/** Each name's lock is free again. */
function assertUnlocked(...vmNames) {
  for (const name of vmNames) acquireVmOperationLock(name, 'test')();
}

beforeEach(() => {
  calls.length = 0;
  for (const key of Object.keys(impl)) delete impl[key];
  impl.updateVMConfig = async (name) => ({ ok: true, requiresRestart: false, name });
  impl.renameVM = async (_name, newName) => ({ name: newName });
});

test('a rename sent with other changes renames, then its follow-ups, then the rest under the new name', async () => {
  await editVmConfig({ name: 'a', changes: { name: 'b', vcpus: 2 }, log });
  assert.deepEqual(calls, [
    ['renameVM', 'a', 'b'],
    ['renameWorkloadAssignment', 'vm', 'a', 'b'],
    ['moveBackupStatus', { type: 'vm', from: 'a', to: 'b' }],
    ['updateVMConfig', 'b', { vcpus: 2 }],
  ]);
  assertUnlocked('a', 'b');
});

test('a rename whose other changes fail answers their error, the rename and its follow-ups standing', async () => {
  impl.updateVMConfig = async () => { throw createAppError('LIBVIRT_ERROR', 'Failed to update the configuration of VM "b"'); };
  await assert.rejects(
    editVmConfig({ name: 'a', changes: { name: 'b', vcpus: 2 }, log }),
    (err) => err.code === 'LIBVIRT_ERROR',
  );
  assert.deepEqual(names(), ['renameVM', 'renameWorkloadAssignment', 'moveBackupStatus', 'updateVMConfig']);
  assert.deepEqual(calls.at(-1), ['updateVMConfig', 'b', { vcpus: 2 }]);
  assertUnlocked('a', 'b');
});

test('a rename alone is one manager call and its follow-ups', async () => {
  await editVmConfig({ name: 'a', changes: { name: 'b' }, log });
  assert.deepEqual(names(), ['renameVM', 'renameWorkloadAssignment', 'moveBackupStatus']);
});

test('an edit without a rename is one manager call under the name, with no follow-ups', async () => {
  await editVmConfig({ name: 'a', changes: { name: 'a', vcpus: 2 }, log });
  assert.deepEqual(calls, [['updateVMConfig', 'a', { vcpus: 2 }]]);
});

test('a delete is followed by its follow-ups: the backup status and the section assignment go', async () => {
  const { jobId } = await startVmDeleteJob({ name: 'gone', deleteDisks: true, log });
  assert.equal(await whenJobEnds(jobId), 'done');
  assert.deepEqual(calls, [
    ['assertVMState', 'gone', 'exists'],
    ['deleteVM', 'gone', true],
    ['forgetBackupStatus', { type: 'vm', name: 'gone' }],
    ['removeWorkloadAssignment', 'vm', 'gone'],
  ]);
});

test('a delete that left the VM folder behind still runs its follow-ups, then fails with that error', async () => {
  impl.deleteVM = async () => { throw createAppError('VM_DELETE_INCOMPLETE', 'VM "gone" was deleted, but its folder /v/gone could not be removed'); };
  const { jobId } = await startVmDeleteJob({ name: 'gone', deleteDisks: true, log });
  assert.equal(await whenJobEnds(jobId), 'error');
  assert.deepEqual(names(), ['assertVMState', 'deleteVM', 'forgetBackupStatus', 'removeWorkloadAssignment']);
});

test('a delete that failed before the VM was gone runs no follow-ups', async () => {
  impl.deleteVM = async () => { throw createAppError('LIBVIRT_ERROR', 'Failed to stop VM "gone" before deleting it'); };
  const { jobId } = await startVmDeleteJob({ name: 'gone', deleteDisks: true, log });
  assert.equal(await whenJobEnds(jobId), 'error');
  assert.deepEqual(names(), ['assertVMState', 'deleteVM']);
});

const SETUP = { hostname: 'w', username: 'wisp', password: 'pw' };

test('a create with a first boot setup is refused for a profile that takes none, before any job', () => {
  for (const profile of ['windows-11', 'other']) {
    assert.throws(
      () => startVmCreateJob({ spec: { name: 'w', profile, cloudInit: SETUP }, log }),
      (err) => err.code === 'INVALID_REQUEST' && err.message.includes(profile),
    );
  }
  assert.deepEqual(calls, []);
});

test('a Linux create with a first boot setup builds it into the new VM', async () => {
  impl.createVM = async (_spec, { populateVMDir }) => { await populateVMDir(); };
  const { jobId } = await startVmCreateJob({ spec: { name: 'l', profile: 'linux', cloudInit: SETUP }, log });
  assert.equal(await whenJobEnds(jobId), 'done');
  assert.deepEqual(names(), ['assertVMNameAvailable', 'createVM', 'generateCloudInit']);
  assertUnlocked('l');
});

test('a first boot setup is saved only on a VM whose profile takes one; one with no profile is refused', async () => {
  for (const profile of ['windows-11', 'other', null]) {
    calls.length = 0;
    impl.getVMConfig = async () => ({ name: 'v', profile });
    await assert.rejects(saveVmCloudInit('v', SETUP, log), (err) => err.code === 'INVALID_REQUEST');
    assert.deepEqual(names(), ['getVMConfig']);
  }
  impl.getVMConfig = async () => ({ name: 'v', profile: 'linux' });
  await saveVmCloudInit('v', SETUP, log);
  assert.deepEqual(calls.at(-1), ['updateCloudInit', 'v', SETUP, log]);
  assertUnlocked('v');
});
