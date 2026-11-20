/*
 * The container commands with the manager, the app modules and the
 * follow-ups' stores mocked (node --test --experimental-test-module-mocks):
 * the lock, the job starter and the follow-up orchestration are the real
 * ones. Every mocked call is recorded in `calls`, in order; a test sets what
 * a mocked function does in `impl`.
 */
import { after, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

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

mockModule('./containerManager/index.js', [
  'getContainerDir', 'assertContainerState', 'assertContainerNameAvailable', 'listContainers', 'getContainerConfig',
  'createContainer', 'startContainer', 'stopContainer', 'restartContainer', 'killContainer', 'deleteContainer',
  'renameContainer', 'updateContainerConfig', 'addContainerMount', 'updateContainerMount', 'removeContainerMount',
  'addContainerService', 'updateContainerService', 'removeContainerService', 'planMountFileUpload',
  'commitMountFileUpload', 'assertMountTakesZip', 'planMountZipExtract', 'extractMountZip', 'assertMountOperation',
  'initMountContent', 'deleteMountData', 'deleteRemovedMountData', 'putMountFileTextContent', 'createContainerBackup',
  'planContainerBackupRestore', 'restoreContainerBackup', 'restoreContainerBackupInPlace', 'pullImage',
  'getImageDigest', 'resolveContainerImageRef',
]);
mockModule('./containerApps/index.js', [
  'createAppContainer', 'applyAppConfig', 'eject', 'maskContainerConfigSecrets', 'assertMountNotAppManaged',
  'assertMountListNotAppManaged',
]);
mockModule('./backupDestinations.js', ['resolveBackupDestinations', 'backupToEachDestination']);
mockModule('./backupStatus.js', ['recordBackupAttempt', 'moveBackupStatus', 'forgetBackupStatus']);
mockModule('./sections.js', ['renameWorkloadAssignment', 'removeWorkloadAssignment']);
mockModule('./vmMdnsReconciler.js', ['publishVm', 'unpublishVm']);
mockModule('./containerMdnsReconciler.js', ['publishContainer', 'unpublishContainer']);

const {
  editContainerConfig, killContainerNow, startContainerDeleteJob, startContainerDeployJob, startContainerStopJob,
  startContainerZipExtractJob,
} = await import('./containerOperations.js');
const { tryAcquireContainerOperationLock } = await import('./containerOperationLock.js');
const { listJobs, readJob, whenJobEnds } = await import('./jobs/index.js');

/** A container directory of its own, for the commands that write into it. */
const containerDir = mkdtempSync(path.join(tmpdir(), 'wisp-container-ops-test-'));
after(() => rmSync(containerDir, { recursive: true, force: true }));

const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return log; } };

/** The recorded calls by function name, in order. */
const names = () => calls.map(([name]) => name);

/** True while a command holds `name`'s lock. */
function isLocked(name) {
  const release = tryAcquireContainerOperationLock(name, 'test');
  release?.();
  return !release;
}

/** Both names' locks are free again. */
function assertUnlocked(...containerNames) {
  for (const name of containerNames) {
    const release = tryAcquireContainerOperationLock(name, 'test');
    assert.ok(release, `the lock on "${name}" is free`);
    release();
  }
}

beforeEach(() => {
  calls.length = 0;
  for (const key of Object.keys(impl)) delete impl[key];
  impl.getContainerConfig = async () => ({ metadata: {} });
  impl.renameContainer = async (_from, to) => ({ name: to });
  impl.updateContainerConfig = async () => ({ removedMounts: [] });
  impl.getContainerDir = () => containerDir;
});

test('a rename sent with other changes renames, then its follow-ups, then the rest under the new name', async () => {
  await editContainerConfig({ name: 'a', changes: { name: 'b', envPatch: { K: { value: 'v' } } }, log });
  assert.deepEqual(calls.slice(1), [
    ['renameContainer', 'a', 'b'],
    ['renameWorkloadAssignment', 'container', 'a', 'b'],
    ['moveBackupStatus', { type: 'container', from: 'a', to: 'b' }],
    ['unpublishContainer', 'a'],
    ['publishContainer', 'b'],
    ['updateContainerConfig', 'b', { envPatch: { K: { value: 'v' } } }],
  ]);
  assertUnlocked('a', 'b');
});

test('a rename whose other changes fail answers their error, the rename and its follow-ups standing', async () => {
  impl.updateContainerConfig = async () => { throw createAppError('CONFIG_ERROR', 'envPatch.K: a new secret needs a value'); };
  await assert.rejects(
    editContainerConfig({ name: 'a', changes: { name: 'b', envPatch: { K: { secret: true } } }, log }),
    (err) => err.code === 'CONFIG_ERROR',
  );
  assert.deepEqual(names().slice(1), [
    'renameContainer', 'renameWorkloadAssignment', 'moveBackupStatus', 'unpublishContainer', 'publishContainer',
    'updateContainerConfig',
  ]);
  assertUnlocked('a', 'b');
});

test('a failed rename changes nothing else', async () => {
  impl.renameContainer = async () => { throw createAppError('CONTAINER_MUST_BE_STOPPED', 'Stop it first'); };
  await assert.rejects(
    editContainerConfig({ name: 'a', changes: { name: 'b', autostart: true }, log }),
    (err) => err.code === 'CONTAINER_MUST_BE_STOPPED',
  );
  assert.deepEqual(names(), ['renameContainer']);
});

test('a zip upload holds the lock from its first byte to the end of its extract, as one job', async () => {
  const held = [];
  impl.planMountZipExtract = async (_name, _mount, staged) => {
    held.push(['plan', isLocked('z')]);
    return { staged };
  };
  impl.extractMountZip = async ({ staged }) => {
    held.push(['extract', isLocked('z'), existsSync(staged)]);
  };
  const ack = await startContainerZipExtractJob({
    name: 'z',
    mountName: 'data',
    stage: async (stagingPath) => {
      held.push(['stage', isLocked('z')]);
      writeFileSync(stagingPath, 'PK');
    },
    log,
  });
  assert.equal(ack.kind, 'container-zip-extract');
  assert.equal(await whenJobEnds(ack.jobId), 'done');
  assert.deepEqual(held, [['stage', true], ['plan', true], ['extract', true, true]]);
  assert.deepEqual(readdirSync(containerDir), [], 'the staging file goes with the extract');
  assertUnlocked('z');
});

test('a zip upload refused while it stages answers the error, with no job, no staging file and the lock free', async () => {
  const jobsBefore = listJobs().length;
  await assert.rejects(
    startContainerZipExtractJob({
      name: 'z',
      mountName: 'data',
      stage: async (stagingPath) => {
        writeFileSync(stagingPath, 'PK');
        throw createAppError('UPLOAD_TOO_LARGE', 'File too large');
      },
      log,
    }),
    (err) => err.code === 'UPLOAD_TOO_LARGE',
  );
  assert.equal(listJobs().length, jobsBefore);
  assert.deepEqual(readdirSync(containerDir), []);
  assert.equal(names().includes('extractMountZip'), false);
  assertUnlocked('z');
});

test('a deploy whose start fails on an error with no table code answers INTERNAL_ERROR, saying the container exists', async () => {
  impl.startContainer = async () => { throw Object.assign(new Error("EACCES: permission denied, open '/srv/x/runs/1.log'"), { code: 'EACCES' }); };
  const { jobId } = await startContainerDeployJob({ name: 'd', image: 'nginx:1.27', env: {}, changes: {}, log });
  assert.equal(await whenJobEnds(jobId), 'error');
  assert.deepEqual(readJob(jobId), {
    ...readJob(jobId),
    error: 'INTERNAL_ERROR',
    detail: 'Container "d" was created but failed to start; it exists in stopped state (check get_container_logs, or fix '
      + "and start_container): EACCES: permission denied, open '<path>'",
  });
});

test('a deploy whose settings fail keeps their code and says the container exists, stopped', async () => {
  impl.updateContainerConfig = async () => { throw createAppError('CONFIG_ERROR', 'cpuLimit exceeds the host\'s 4 cores'); };
  const { jobId } = await startContainerDeployJob({ name: 'd', image: 'nginx:1.27', env: {}, changes: { cpuLimit: 8 }, log });
  assert.equal(await whenJobEnds(jobId), 'error');
  const { error, detail } = readJob(jobId);
  assert.equal(error, 'CONFIG_ERROR');
  assert.equal(detail, 'Container "d" was created but its settings could not be applied; it exists in stopped state '
    + "(fix it, then start_container): cpuLimit exceeds the host's 4 cores");
  assert.equal(names().includes('startContainer'), false);
});

test('a delete is followed by its follow-ups: the .local name, the backup status and the section assignment go', async () => {
  const { jobId } = await startContainerDeleteJob({ name: 'gone', log });
  assert.equal(await whenJobEnds(jobId), 'done');
  assert.deepEqual(calls, [
    ['assertContainerState', 'gone', 'exists'],
    ['deleteContainer', 'gone', true],
    ['unpublishContainer', 'gone'],
    ['forgetBackupStatus', { type: 'container', name: 'gone' }],
    ['removeWorkloadAssignment', 'container', 'gone'],
  ]);
});

test('a kill during a stop cuts its grace period short: it answers at once, and only the stop acts on the task', async () => {
  impl.stopContainer = (_name, { graceSignal }) => new Promise((resolve) => {
    graceSignal.addEventListener('abort', () => {
      calls.push(['grace cut short']);
      resolve({ restartCancelled: false });
    });
  });
  const { jobId } = await startContainerStopJob({ name: 's', log });
  assert.equal(await killContainerNow('s'), undefined);
  assert.equal(await whenJobEnds(jobId), 'done');
  assert.deepEqual(names(), ['assertContainerState', 'stopContainer', 'grace cut short']);
  assert.equal(names().includes('killContainer'), false);
  assertUnlocked('s');
});

test('a kill before the stop has registered its grace period answers CONTAINER_BUSY', async () => {
  const checked = Promise.withResolvers();
  impl.assertContainerState = () => checked.promise;
  impl.stopContainer = async () => ({ restartCancelled: false });
  const stopping = startContainerStopJob({ name: 's', log });
  await assert.rejects(killContainerNow('s'), (err) => err.code === 'CONTAINER_BUSY');
  checked.resolve();
  assert.equal(await whenJobEnds((await stopping).jobId), 'done');
  assert.equal(names().includes('killContainer'), false);
});

test('a kill with no stop running takes the lock and kills', async () => {
  await killContainerNow('k');
  assert.deepEqual(calls, [['killContainer', 'k']]);
  assertUnlocked('k');
});
