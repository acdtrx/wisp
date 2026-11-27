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
import { createEmitter } from './base/index.js';
import { JOB_KIND } from '../../../shared/wireNames.js';

const calls = [];
const impl = {};

/** Named exports that record each call and answer what `impl` says (undefined by default). */
function recorded(names) {
  return Object.fromEntries(names.map((name) => [name, (...args) => {
    calls.push([name, ...args]);
    return impl[name]?.(...args);
  }]));
}

const mockModule = (path, names) => mock.module(new URL(path, import.meta.url).href, { exports: recorded(names) });

mockModule('./vmManager/index.js', [
  'assertVMNameAvailable', 'createVM', 'assertVMState', 'startVM', 'stopVM', 'forceStopVM', 'rebootVM', 'suspendVM',
  'resumeVM', 'deleteVM', 'updateVMConfig', 'renameVM', 'attachDisk', 'createAndAttachDisk', 'detachDisk', 'resizeDiskBySlot',
  'attachISO', 'ejectISO', 'attachUSBDevice', 'detachUSBDevice', 'createBackup', 'listVMs', 'subscribeVMListChange',
  'isShutOff', 'planBackupRestore', 'restoreBackup', 'getVMConfig',
]);
mockModule('./cloudInit.js', ['generateCloudInit', 'rebuildCloudInitISO', 'updateCloudInit', 'detachCloudInitDisk']);
mockModule('./paths.js', ['isPathInsideAllowedRoots']);
mockModule('./backupDestinations.js', ['resolveBackupDestinations', 'backupToEachDestination']);
mockModule('./backupStatus.js', ['recordBackupAttempt', 'moveBackupStatus', 'forgetBackupStatus']);
mockModule('./sections.js', ['renameWorkloadAssignment', 'removeWorkloadAssignment']);
mockModule('./containerMdnsReconciler.js', ['publishContainer', 'unpublishContainer']);

const {
  editVmConfig, saveVmCloudInit, startVmCreateJob, startVmDeleteJob, startVmStopJob, startVmForceStopJob,
} = await import('./vmOperations.js');
const { readJob, whenJobEnds } = await import('./jobs/index.js');
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
    await assert.rejects(saveVmCloudInit('v', SETUP), (err) => err.code === 'INVALID_REQUEST');
    assert.deepEqual(names(), ['getVMConfig']);
  }
  impl.getVMConfig = async () => ({ name: 'v', profile: 'linux' });
  await saveVmCloudInit('v', SETUP);
  assert.deepEqual(calls.at(-1), ['updateCloudInit', 'v', SETUP]);
  assertUnlocked('v');
});

/*
 * The stop: the VM list is the one the stop watches. `listChange` holds its
 * subscribers; `announce(state)` tells them the list with VM `s` in that state
 * (a libvirt state code: 1 running, 5 shut off).
 */
let listChange;
let listed = 1;
function announce(stateCode) {
  listed = stateCode;
  listChange.emit([{ name: 's', stateCode }]);
}

function standInVmList() {
  listChange = createEmitter('test VM list', () => log);
  listed = 1;
  impl.isShutOff = (code) => code === 5;
  impl.listVMs = async () => [{ name: 's', stateCode: listed }];
  impl.subscribeVMListChange = listChange.subscribe;
}

/** Until the stop's request has been sent and its wait begun. */
async function untilWaiting(jobId) {
  while (readJob(jobId).progress?.step !== 'shutting-down') await new Promise(setImmediate);
}

test('a stop asks the guest, then waits without the lock, and ends done once the VM is off', async () => {
  standInVmList();
  const { jobId, kind } = await startVmStopJob({ name: 's', log });
  assert.equal(kind, JOB_KIND.VM_STOP);
  await untilWaiting(jobId);
  // The watch is set up before the request, so an off right after it is not missed.
  assert.deepEqual(names().slice(0, 3), ['assertVMState', 'subscribeVMListChange', 'stopVM']);
  assert.deepEqual(calls[0], ['assertVMState', 's', 'stop']);
  assertUnlocked('s');
  assert.equal(readJob(jobId).status, 'running');
  announce(5);
  assert.equal(await whenJobEnds(jobId), 'done');
  assert.deepEqual(readJob(jobId).result, { name: 's' });
  assert.equal(listChange.size(), 0, 'the watch ended');
});

test('a stop of a VM that is not running is refused before any job', async () => {
  standInVmList();
  impl.assertVMState = async () => { throw createAppError('VM_NOT_RUNNING', 'VM "s" is not running'); };
  await assert.rejects(startVmStopJob({ name: 's', log }), (err) => err.code === 'VM_NOT_RUNNING');
  assert.ok(!names().includes('stopVM'));
  assertUnlocked('s');
});

test('a second stop while the first waits answers the first one\'s ack', async () => {
  standInVmList();
  const first = await startVmStopJob({ name: 's', log });
  await untilWaiting(first.jobId);
  const second = await startVmStopJob({ name: 's', log });
  assert.deepEqual(second, first);
  assert.equal(names().filter((n) => n === 'stopVM').length, 1);
  announce(5);
  assert.equal(await whenJobEnds(first.jobId), 'done');
});

test('a force stop while a stop waits is accepted, and the stop ends done', async () => {
  standInVmList();
  impl.forceStopVM = async () => { announce(5); };
  const stop = await startVmStopJob({ name: 's', log });
  await untilWaiting(stop.jobId);
  const force = await startVmForceStopJob({ name: 's', log });
  assert.equal(await whenJobEnds(force.jobId), 'done');
  assert.equal(await whenJobEnds(stop.jobId), 'done');
  assertUnlocked('s');
});

test('a VM already off when the wait begins ends the stop done', async () => {
  standInVmList();
  impl.stopVM = async () => { listed = 5; };
  const { jobId } = await startVmStopJob({ name: 's', log });
  assert.equal(await whenJobEnds(jobId), 'done');
});

test('a VM not off 5 min after the request fails the stop with VM_STOP_TIMEOUT, and is left as it is', async (t) => {
  standInVmList();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { jobId } = await startVmStopJob({ name: 's', log });
  await untilWaiting(jobId);
  t.mock.timers.tick(5 * 60 * 1000 - 1);
  await new Promise(setImmediate);
  assert.equal(readJob(jobId).status, 'running', 'not before the bound');
  t.mock.timers.tick(1);
  assert.equal(await whenJobEnds(jobId), 'error');
  assert.equal(readJob(jobId).error, 'VM_STOP_TIMEOUT');
  assert.ok(!names().includes('forceStopVM'), 'the VM is left running');
  assert.equal(listChange.size(), 0, 'the watch ended');
});
