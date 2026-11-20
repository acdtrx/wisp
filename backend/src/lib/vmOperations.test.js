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
  'resumeVM', 'deleteVM', 'updateVMConfig', 'attachDisk', 'createAndAttachDisk', 'detachDisk', 'resizeDiskBySlot',
  'updateDiskBus', 'attachISO', 'ejectISO', 'attachUSBDevice', 'detachUSBDevice', 'createBackup', 'listVMs',
  'isOfflineState', 'planBackupRestore', 'restoreBackup',
]);
mockModule('./cloudInit.js', ['generateCloudInit', 'rebuildCloudInitISO', 'updateCloudInit', 'detachCloudInitDisk']);
mockModule('./paths.js', ['isPathInsideAllowedRoots']);
mockModule('./backupDestinations.js', ['resolveBackupDestinations', 'backupToEachDestination']);
mockModule('./backupStatus.js', ['recordBackupAttempt', 'moveBackupStatus', 'forgetBackupStatus']);
mockModule('./sections.js', ['renameWorkloadAssignment', 'removeWorkloadAssignment']);
mockModule('./vmMdnsReconciler.js', ['publishVm', 'unpublishVm']);
mockModule('./containerMdnsReconciler.js', ['publishContainer', 'unpublishContainer']);

const { editVmConfig, startVmDeleteJob } = await import('./vmOperations.js');
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
  impl.updateVMConfig = async (name, changes) => ({ ok: true, requiresRestart: false, name: changes.name ?? name });
});

test('a rename sent with other changes renames, then its follow-ups, then the rest under the new name', async () => {
  await editVmConfig({ name: 'a', changes: { name: 'b', firmware: 'uefi', localDns: true }, log });
  assert.deepEqual(calls, [
    ['updateVMConfig', 'a', { name: 'b' }],
    ['renameWorkloadAssignment', 'vm', 'a', 'b'],
    ['moveBackupStatus', { type: 'vm', from: 'a', to: 'b' }],
    ['unpublishVm', 'a'],
    ['publishVm', 'b'],
    ['updateVMConfig', 'b', { firmware: 'uefi', localDns: true }],
    ['publishVm', 'b'],
  ]);
  assertUnlocked('a', 'b');
});

test('a rename whose other changes fail answers their error, the rename and its follow-ups standing', async () => {
  impl.updateVMConfig = async (name, changes) => {
    if (changes.firmware) throw createAppError('LIBVIRT_ERROR', 'Failed to update the firmware of VM "b"');
    return { ok: true, requiresRestart: false, name: changes.name ?? name };
  };
  await assert.rejects(
    editVmConfig({ name: 'a', changes: { name: 'b', firmware: 'uefi' }, log }),
    (err) => err.code === 'LIBVIRT_ERROR',
  );
  assert.deepEqual(names(), [
    'updateVMConfig', 'renameWorkloadAssignment', 'moveBackupStatus', 'unpublishVm', 'publishVm', 'updateVMConfig',
  ]);
  assert.deepEqual(calls.at(-1), ['updateVMConfig', 'b', { firmware: 'uefi' }]);
  assertUnlocked('a', 'b');
});

test('a rename alone is one manager call and its follow-ups', async () => {
  await editVmConfig({ name: 'a', changes: { name: 'b' }, log });
  assert.deepEqual(names(), ['updateVMConfig', 'renameWorkloadAssignment', 'moveBackupStatus', 'unpublishVm', 'publishVm']);
});

test('an edit without a rename is one manager call under the name, then its follow-ups', async () => {
  await editVmConfig({ name: 'a', changes: { name: 'a', localDns: false }, log });
  assert.deepEqual(calls, [['updateVMConfig', 'a', { localDns: false }], ['unpublishVm', 'a']]);
});

test('a delete is followed by its follow-ups: the .local name, the backup status and the section assignment go', async () => {
  const { jobId } = await startVmDeleteJob({ name: 'gone', deleteDisks: true, log });
  assert.equal(await whenJobEnds(jobId), 'done');
  assert.deepEqual(calls, [
    ['assertVMState', 'gone', 'exists'],
    ['deleteVM', 'gone', true],
    ['unpublishVm', 'gone'],
    ['forgetBackupStatus', { type: 'vm', name: 'gone' }],
    ['removeWorkloadAssignment', 'vm', 'gone'],
  ]);
});
