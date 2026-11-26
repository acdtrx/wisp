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

mockModule('./containerManager/index.js', [
  'getContainerDir', 'assertContainerState', 'assertContainerNameAvailable', 'listContainers', 'getContainerConfig',
  'createContainer', 'startContainer', 'stopContainer', 'restartContainer', 'killContainer', 'deleteContainer',
  'renameContainer', 'updateContainerConfig', 'addContainerMount', 'updateContainerMount', 'removeContainerMount',
  'addContainerService', 'updateContainerService', 'removeContainerService', 'planMountFileUpload',
  'commitMountFileUpload', 'assertMountTakesZip', 'planMountZipExtract', 'extractMountZip', 'assertMountOperation',
  'initMountContent', 'deleteMountData', 'deleteRemovedMountData', 'putMountFileTextContent', 'createContainerBackup',
  'planContainerBackupRestore', 'restoreContainerBackup', 'restoreContainerBackupInPlace', 'resolveContainerBackupDir', 'pullImage',
  'getImageDigest', 'resolveContainerImageRef', 'isLocalImageRef',
]);
mockModule('./containerApps/index.js', [
  'createAppContainer', 'applyAppConfig', 'eject', 'maskContainerConfigSecrets', 'getAppModule', 'assertMountNotAppManaged',
  'assertMountListNotAppManaged',
]);
mockModule('./hostCertificateStore.js', ['getHeldCertificate']);
mockModule('./backupDestinations.js', ['resolveBackupDestinations', 'backupToEachDestination']);
mockModule('./backupStatus.js', ['recordBackupAttempt', 'moveBackupStatus', 'forgetBackupStatus']);
mockModule('./sections.js', ['renameWorkloadAssignment', 'removeWorkloadAssignment']);
mockModule('./containerMdnsReconciler.js', ['publishContainer', 'unpublishContainer']);

const {
  editContainerConfig, editContainerMountRow, initContainerMountContent, killContainerNow, saveAgentAppConfig,
  saveContainerAppConfig, startContainerDeleteJob, startContainerDeployJob, startContainerImageUpdateJob, startContainerStopJob,
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
  assert.equal(ack.kind, JOB_KIND.CONTAINER_ZIP_EXTRACT);
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

test('a delete that could not release the network lease still runs its follow-ups, then fails with that error', async () => {
  impl.deleteContainer = async () => {
    throw createAppError('CONTAINER_DELETE_INCOMPLETE', 'Container "gone" was deleted, but its network lease was not released');
  };
  const { jobId } = await startContainerDeleteJob({ name: 'gone', log });
  assert.equal(await whenJobEnds(jobId), 'error');
  assert.deepEqual(names(), [
    'assertContainerState', 'deleteContainer', 'unpublishContainer', 'forgetBackupStatus', 'removeWorkloadAssignment',
  ]);
});

test('a delete stopped at a failed step runs no follow-ups', async () => {
  impl.deleteContainer = async () => { throw createAppError('CONTAINERD_ERROR', 'Could not delete container "gone": removing its snapshot failed'); };
  const { jobId } = await startContainerDeleteJob({ name: 'gone', log });
  assert.equal(await whenJobEnds(jobId), 'error');
  assert.deepEqual(names(), ['assertContainerState', 'deleteContainer']);
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

/* ── An agent token's narrowed requests (docs/specs/AUTH.md, The `agent` scope) ── */

const SHARE_MOUNT = { name: 'media', type: 'directory', containerPath: '/media', sourceId: 'nas', subPath: 'films' };
const LOCAL_MOUNT = { name: 'site', type: 'directory', containerPath: '/srv' };

test('an agent token cannot edit or init a mount backed by a storage mount; the mount is not touched', async () => {
  impl.getContainerConfig = async () => ({ metadata: {}, mounts: [SHARE_MOUNT, LOCAL_MOUNT] });
  for (const run of [
    () => editContainerMountRow('c', 'media', { readonly: true }, { scope: 'agent' }),
    () => initContainerMountContent('c', 'media', { scope: 'agent' }),
  ]) {
    calls.length = 0;
    await assert.rejects(run(), (err) => err.code === 'SCOPE_INSUFFICIENT' && /Mount "media" is backed by a storage mount/.test(err.message));
    assert.deepEqual(names().filter((n) => n !== 'getContainerConfig' && n !== 'assertMountNotAppManaged'), []);
  }
  assertUnlocked('c');
});

test('the same mount edit and init pass for a session and an admin token, and a Local mount for an agent token', async () => {
  impl.getContainerConfig = async () => ({ metadata: {}, mounts: [SHARE_MOUNT, LOCAL_MOUNT] });
  for (const [mount, scope] of [['media', null], ['media', 'admin'], ['site', 'agent']]) {
    calls.length = 0;
    await editContainerMountRow('c', mount, { readonly: true }, { scope });
    await initContainerMountContent('c', mount, { scope });
    assert.deepEqual(names().filter((n) => n === 'updateContainerMount' || n === 'initMountContent'), ['updateContainerMount', 'initMountContent'], `${mount} ${scope}`);
  }
});

const CADDY = { metadata: { app: 'caddy-reverse-proxy', appConfig: { hosts: [{ subdomain: 'a', target: 'a.local:80' }], other: 'kept' } } };

/** The appConfig handed to the app's save, or the code the save was refused with. */
async function savedAppConfig(save) {
  try {
    await save();
  } catch (err) {
    assert.equal(names().includes('applyAppConfig'), false, 'nothing is saved on a refusal');
    return err.code;
  }
  return calls.find(([n]) => n === 'applyAppConfig')[2];
}

test('an agent token\'s appConfig replaces its agent-writable keys and keeps the rest of the stored config', async () => {
  impl.getContainerConfig = async () => CADDY;
  impl.getAppModule = () => ({ agentWritableAppConfigFields: ['hosts'] });
  const hosts = [{ subdomain: 'b', target: 'b.local:80' }];
  assert.deepEqual(await savedAppConfig(() => saveContainerAppConfig({ name: 'caddy', appConfig: { hosts }, scope: 'agent' })), { hosts, other: 'kept' });
  calls.length = 0;
  assert.deepEqual(await savedAppConfig(() => saveAgentAppConfig('caddy', { hosts })), { hosts, other: 'kept' });
});

test('a session\'s and an admin token\'s appConfig is the whole config', async () => {
  impl.getContainerConfig = async () => CADDY;
  for (const scope of [null, 'admin']) {
    calls.length = 0;
    assert.deepEqual(await savedAppConfig(() => saveContainerAppConfig({ name: 'caddy', appConfig: { domain: 'x' }, scope })), { domain: 'x' });
  }
});

test('a key outside the writable ones, or an app with none, is refused for the scope over REST and for every caller over MCP', async () => {
  impl.getContainerConfig = async () => CADDY;
  for (const writable of [['hosts'], [], undefined]) {
    impl.getAppModule = () => (writable === undefined ? {} : { agentWritableAppConfigFields: writable });
    calls.length = 0;
    assert.equal(await savedAppConfig(() => saveContainerAppConfig({ name: 'caddy', appConfig: { other: 'x' }, scope: 'agent' })), 'SCOPE_INSUFFICIENT');
    calls.length = 0;
    assert.equal(await savedAppConfig(() => saveAgentAppConfig('caddy', { other: 'x' })), 'APP_CONFIG_ONLY');
  }
  assertUnlocked('caddy');
});

test('an agent token\'s appConfig on a generic container is CONFIG_ERROR, as the tool\'s is', async () => {
  impl.getContainerConfig = async () => ({ metadata: {} });
  assert.equal(await savedAppConfig(() => saveContainerAppConfig({ name: 'web', appConfig: { hosts: [] }, scope: 'agent' })), 'CONFIG_ERROR');
  calls.length = 0;
  assert.equal(await savedAppConfig(() => saveAgentAppConfig('web', { hosts: [] })), 'CONFIG_ERROR');
});

test('an image update to a localhost/ ref pulls nothing: a held image is used, and one not held is CONTAINER_IMAGE_NOT_FOUND', async () => {
  impl.isLocalImageRef = (ref) => ref.startsWith('localhost/');
  impl.resolveContainerImageRef = async (ref) => ({ ref, local: ref === 'localhost/myapp:v1' });
  impl.getImageDigest = async (ref) => (ref === 'localhost/myapp:v1' ? 'sha256:01' : null);
  impl.getContainerConfig = async () => ({ image: 'docker.io/library/busybox:latest', state: 'stopped', metadata: {} });

  const held = await startContainerImageUpdateJob({ name: 'web', image: 'localhost/myapp:v1', log });
  assert.equal(await whenJobEnds(held.jobId), 'done');
  assert.equal(readJob(held.jobId).result.image, 'localhost/myapp:v1');
  assert.ok(!names().includes('pullImage'), 'no pull');

  calls.length = 0;
  const missing = await startContainerImageUpdateJob({ name: 'web', image: 'localhost/gone:v1', log });
  assert.equal(await whenJobEnds(missing.jobId), 'error');
  assert.equal(readJob(missing.jobId).error, 'CONTAINER_IMAGE_NOT_FOUND');
  assert.ok(!names().includes('pullImage'), 'no pull');
});

test('an image update to a registry ref, localhost:5000 among them, pulls it', async () => {
  impl.isLocalImageRef = (ref) => ref.startsWith('localhost/');
  impl.resolveContainerImageRef = async (ref) => ({ ref, local: false });
  impl.getContainerConfig = async () => ({ image: 'localhost:5000/app:1', state: 'stopped', metadata: {} });
  const { jobId } = await startContainerImageUpdateJob({ name: 'web', image: 'localhost:5000/app:2', log });
  assert.equal(await whenJobEnds(jobId), 'done');
  assert.deepEqual(calls.filter(([n]) => n === 'pullImage').map(([, ref]) => ref), ['localhost:5000/app:2']);
});
