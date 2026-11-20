/*
 * The scheduled run with the manager, the app modules, the settings and the
 * stores mocked (node --test --experimental-test-module-mocks): the container
 * backup operation, its lock and the job starter are the real ones. Every
 * mocked call is recorded in `calls`, in order; a test sets what a mocked
 * function does in `impl`.
 */
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';

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
  'planContainerBackupRestore', 'restoreContainerBackup', 'restoreContainerBackupInPlace', 'resolveContainerBackupDir', 'pullImage',
  'getImageDigest', 'resolveContainerImageRef', 'listContainerBackups', 'deleteContainerBackup',
]);
mockModule('./containerApps/index.js', [
  'createAppContainer', 'applyAppConfig', 'eject', 'maskContainerConfigSecrets', 'assertMountNotAppManaged',
  'assertMountListNotAppManaged',
]);
mockModule('./settings.js', ['getSettings', 'listConfiguredBackupRoots']);
mockModule('./backupDestinations.js', ['resolveBackupDestinations', 'backupToEachDestination']);
mockModule('./backupStatus.js', ['recordBackupAttempt', 'moveBackupStatus', 'forgetBackupStatus']);
mockModule('./sections.js', ['renameWorkloadAssignment', 'removeWorkloadAssignment']);
mockModule('./vmMdnsReconciler.js', ['publishVm', 'unpublishVm']);
mockModule('./containerMdnsReconciler.js', ['publishContainer', 'unpublishContainer']);

const { runScheduledBackups } = await import('./containerBackupScheduler.js');
const { tryAcquireContainerOperationLock } = await import('./containerOperationLock.js');

/** A logger that records each line as `[level, fields, message]`. */
function fakeLog() {
  const lines = [];
  const at = (level) => (fields, message) => lines.push([level, fields, message]);
  const log = { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), child: () => log };
  return log;
}

const LOCAL = { id: 'local', path: '/backups', label: 'Local' };

test('a container busy with another operation is skipped; the run goes on to the next', async () => {
  impl.getSettings = async () => ({ backupSchedule: { destinationIds: ['local'], retainDays: 7, retainWeeks: 4 } });
  impl.listConfiguredBackupRoots = () => ['/backups'];
  impl.listContainers = async () => [{ name: 'busy' }, { name: 'free' }, { name: 'off' }];
  impl.getContainerConfig = async (name) => ({ autoBackup: name !== 'off' });
  impl.assertContainerState = async () => {};
  impl.resolveBackupDestinations = async () => [LOCAL];
  impl.backupToEachDestination = async (destinations, { push, backupOne, afterEach }) => {
    let last;
    for (const dest of destinations) {
      last = await backupOne(dest, push);
      await afterEach?.(dest);
    }
    return last;
  };
  impl.createContainerBackup = async () => ({ timestamp: '2026-11-20T03-00-00' });
  impl.listContainerBackups = async () => [];

  const release = tryAcquireContainerOperationLock('busy', 'restore');
  const log = fakeLog();
  try {
    assert.equal(await runScheduledBackups({ trigger: 'test', log }), true);
  } finally {
    release();
  }

  const backups = calls.filter(([name]) => name === 'createContainerBackup');
  assert.deepEqual(backups.map(([, container, path, opts]) => [container, path, opts.origin]), [['free', '/backups', 'scheduled']]);
  assert.ok(log.lines.some(([level, fields, message]) => level === 'warn' && fields.container === 'busy'
    && fields.code === 'CONTAINER_BUSY' && message === 'Backup scheduler: container busy or gone, skipping container'));
  assert.deepEqual(log.lines.at(-1), ['info', { trigger: 'test', backedUp: 1, failed: 0, skipped: 1 }, 'Backup scheduler: run finished']);
});
