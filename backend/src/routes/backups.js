import { join } from 'node:path';

import {
  listBackups,
  restoreBackup,
  deleteBackup,
  resolveVmBackupDir,
  planBackupRestore,
} from '../lib/vmManager/index.js';
import { rebuildCloudInitISO } from '../lib/cloudInit.js';
import { isPathInsideAllowedRoots } from '../lib/paths.js';
import {
  listContainerBackups,
  planContainerBackupRestore,
  restoreContainerBackup,
  restoreContainerBackupInPlace,
  deleteContainerBackup,
  createContainerBackup,
  listContainers,
} from '../lib/containerManager/index.js';
import { getSettings, getRawMounts, listConfiguredBackupRoots, listBackupDestinationsWithMountCheck } from '../lib/settings.js';
import { resolveBackupDestinations } from '../lib/backupDestinations.js';
import { recordBackupAttempt } from '../lib/backupStatus.js';
import {
  startJob,
  BACKGROUND_JOB_KIND,
  titleForContainerRestore,
  titleForVmRestore,
  titleForContainerRestoreAsNew,
} from '../lib/jobs/index.js';
import { createAppError } from '../lib/appErrors.js';
import { validateVMName, validateContainerName } from '../lib/validation.js';
import { jobAckSchema } from './schemas.js';

// Backup directory names produced by createBackup are ISO-derived
// (YYYY-MM-DDTHH-mm-ss). The accept-set is intentionally a bit looser to
// keep older folder formats listable/deletable. The character class blocks
// `/`, `\`, NUL, etc.; the leading alphanumeric is what blocks `.` and `..`,
// so the timestamp is always a single child segment and server-side path
// construction cannot resolve to (or above) the destination root.
const TIMESTAMP_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TIMESTAMP_MAX_LEN = 64;

function assertSafeTimestamp(ts) {
  if (typeof ts !== 'string' || !ts || ts.length > TIMESTAMP_MAX_LEN || !TIMESTAMP_REGEX.test(ts)) {
    throw createAppError('BACKUP_INVALID', 'Invalid backup timestamp');
  }
}

// Map a client-supplied `destinationId` ('local' | <mountId>) to the absolute
// root path the backup lives under. Anything else is rejected.
function resolveBackupRoot(settings, destinationId) {
  if (typeof destinationId !== 'string' || !destinationId) {
    throw createAppError('BACKUP_INVALID', 'Invalid destinationId');
  }
  if (destinationId === 'local') {
    if (!settings.backupLocalPath) {
      throw createAppError('BACKUP_DEST_NOT_FOUND', 'No local backup destination configured');
    }
    return settings.backupLocalPath;
  }
  if (destinationId !== settings.backupMountId) {
    throw createAppError('BACKUP_INVALID', `Unknown destinationId: ${destinationId}`);
  }
  const m = (settings.mounts || []).find((x) => x.id === destinationId);
  if (!m || !m.mountPath) {
    throw createAppError('BACKUP_DEST_NOT_FOUND', 'Backup mount not configured');
  }
  return m.mountPath;
}

// Drop the internal `path` field from a manager row before serializing.
function stripPath(row) {
  const { path: _internal, ...rest } = row;
  return rest;
}

/**
 * A container in-place restore, run inside its job: an optional safety backup
 * of the current state first (0–45% of the bar), then the restore itself
 * (45–100%). The safety phase's step names are prefixed `safety-` so they read
 * as the safety backup. Resolves the restore's result.
 *
 * @param {object} opts
 * @param {string} opts.name - container name
 * @param {{ id: string, path: string }} opts.dest - resolved destination (safety backup target)
 * @param {boolean} opts.safetyBackup
 * @param {(onProgress: (ev: object) => void) => Promise<object>} opts.runSafetyBackup
 * @param {(onProgress: (ev: object) => void) => Promise<object>} opts.runRestore
 * @param {(event: object) => void} opts.report - the job's progress reporter
 */
async function restoreContainerInPlace({ name, dest, safetyBackup, runSafetyBackup, runRestore, report }) {
  const scaledProgress = (base, span, stepPrefix = '') => (ev) => {
    report({
      step: `${stepPrefix}${ev.step}`,
      percent: ev.percent != null ? Math.min(100, Math.round(base + (ev.percent / 100) * span)) : undefined,
      currentFile: ev.currentFile,
    });
  };

  if (safetyBackup) {
    try {
      const res = await runSafetyBackup(scaledProgress(0, 45, 'safety-'));
      await recordBackupAttempt({
        kind: 'container', name, ok: true, origin: 'manual', destinationIds: [dest.id], timestamp: res?.timestamp,
      });
    } catch (err) {
      await recordBackupAttempt({
        kind: 'container', name, ok: false, origin: 'manual', destinationIds: [dest.id], error: err?.message,
      });
      /* Safety backup failed — abort before touching the live workload. */
      throw err;
    }
  }
  return runRestore(scaledProgress(safetyBackup ? 45 : 0, safetyBackup ? 55 : 100));
}

export default async function backupsRoutes(fastify) {
  // GET /backups — list backups from configured destinations; optional ?vmName= filter
  fastify.get('/backups', {
    config: { auth: 'read' },
    schema: {
      querystring: {
        type: 'object',
        properties: { vmName: { type: 'string' } },
        additionalProperties: false,
      },
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              vmName: { type: 'string' },
              timestamp: { type: 'string' },
              destinationId: { type: 'string' },
              destinationLabel: { type: 'string' },
              sizeBytes: { type: 'number' },
              origin: { type: 'string' },
            },
          },
        },
      },
    },
    handler: async (request) => {
      const settings = await getSettings();
      const destinations = await listBackupDestinationsWithMountCheck(settings);
      const vmName = request.query?.vmName ?? null;
      const list = await listBackups(destinations, vmName || undefined);
      return list.map(stripPath);
    },
  });

  // POST /backups/restore — restore backup as new VM
  fastify.post('/backups/restore', {
    config: { auth: 'admin' },
    schema: {
      body: {
        type: 'object',
        required: ['destinationId', 'vmName', 'timestamp', 'newVmName'],
        properties: {
          destinationId: { type: 'string' },
          vmName: { type: 'string' },
          timestamp: { type: 'string' },
          newVmName: { type: 'string' },
        },
        additionalProperties: false,
      },
      response: {
        202: jobAckSchema,
      },
    },
    // A job: restoring copies (and gunzips) every disk. The request is checked
    // here (names, destination, backup folder, the archive's validation); the
    // copy's outcome — the new VM's name, or the error — arrives over the job's
    // stream.
    handler: async (request, reply) => {
      const { destinationId, vmName, timestamp, newVmName } = request.body;
      validateVMName(vmName);
      validateVMName(newVmName);
      assertSafeTimestamp(timestamp);
      const settings = await getSettings();
      const root = resolveBackupRoot(settings, destinationId);
      const backupPath = await resolveVmBackupDir(root, vmName, timestamp);
      let plan;
      // The new VM's name is held for the restore, so nothing creates, starts
      // or edits it while its directory is being populated.
      const job = await startJob({
        kind: BACKGROUND_JOB_KIND.VM_RESTORE,
        title: titleForVmRestore(newVmName),
        subject: { type: 'vm', name: newVmName },
        // A CD-ROM may keep a source outside the new VM directory only under
        // the paths an attach would accept (the image library).
        check: async () => {
          plan = await planBackupRestore(backupPath, newVmName, {
            isExternalSourceAllowed: (absPath) => isPathInsideAllowedRoots(absPath, newVmName),
          });
        },
        log: request.log,
        // Backups don't hold the cloud-init seed ISO; rebuild it from the
        // restored cloud-init.json before the domain is defined.
        run: async () => {
          const result = await restoreBackup(plan, {
            populateVMDir: (vmDir, { xml }) => rebuildCloudInitISO(newVmName, vmDir, xml),
          });
          return { name: result?.name ?? newVmName };
        },
      });
      return reply.code(202).send(job);
    },
  });

  // DELETE /backups — delete a VM backup
  fastify.delete('/backups', {
    config: { auth: 'admin' },
    schema: {
      body: {
        type: 'object',
        required: ['destinationId', 'vmName', 'timestamp'],
        properties: {
          destinationId: { type: 'string' },
          vmName: { type: 'string' },
          timestamp: { type: 'string' },
        },
        additionalProperties: false,
      },
      response: { 204: { type: 'null' } },
    },
    handler: async (request, reply) => {
      const { destinationId, vmName, timestamp } = request.body;
      validateVMName(vmName);
      assertSafeTimestamp(timestamp);
      const settings = await getSettings();
      const root = resolveBackupRoot(settings, destinationId);
      const backupPath = await resolveVmBackupDir(root, vmName, timestamp);
      const roots = listConfiguredBackupRoots(settings);
      await deleteBackup(backupPath, roots);
      return reply.code(204).send();
    },
  });

  // ── Container backups ──────────────────────────────────────────
  // Parallel API to /backups for containers. Container backups live under
  // <dest>/containers/<name>/<timestamp>/ so VM and container backups can
  // never collide on identical names.

  fastify.get('/container-backups', {
    config: { auth: 'read' },
    schema: {
      querystring: {
        type: 'object',
        properties: { containerName: { type: 'string' } },
        additionalProperties: false,
      },
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              timestamp: { type: 'string' },
              destinationId: { type: 'string' },
              destinationLabel: { type: 'string' },
              sizeBytes: { type: 'number' },
              image: { type: ['string', 'null'] },
              origin: { type: 'string' },
            },
          },
        },
      },
    },
    handler: async (request) => {
      const settings = await getSettings();
      const destinations = await listBackupDestinationsWithMountCheck(settings);
      const containerName = request.query?.containerName ?? null;
      const list = await listContainerBackups(destinations, containerName || undefined);
      return list.map(stripPath);
    },
  });

  fastify.post('/container-backups/restore', {
    config: { auth: 'admin' },
    schema: {
      body: {
        type: 'object',
        required: ['destinationId', 'name', 'timestamp', 'newName'],
        properties: {
          destinationId: { type: 'string' },
          name: { type: 'string' },
          timestamp: { type: 'string' },
          newName: { type: 'string' },
        },
        additionalProperties: false,
      },
      response: {
        202: jobAckSchema,
      },
    },
    // A job: the archive is extracted and the image pulled. The request is
    // checked here (names, destination, the new name free, the manifest);
    // `done` is `{ name, sourceName, image }`.
    handler: async (request, reply) => {
      const { destinationId, name, timestamp, newName } = request.body;
      validateContainerName(name);
      validateContainerName(newName);
      assertSafeTimestamp(timestamp);
      const settings = await getSettings();
      const root = resolveBackupRoot(settings, destinationId);
      // Containers live under <root>/containers/<name>/<timestamp>/. The
      // route knows the layout because it owns the API contract; the
      // container manager keeps generic "absolute path in" semantics.
      const backupPath = join(root, 'containers', name, timestamp);
      let plan;
      // The new container's name is held for the restore, so nothing starts
      // or edits it while its directory is being populated.
      const job = await startJob({
        kind: BACKGROUND_JOB_KIND.CONTAINER_RESTORE_AS_NEW,
        title: titleForContainerRestoreAsNew(newName),
        subject: { type: 'container', name: newName },
        check: async () => { plan = await planContainerBackupRestore(backupPath, newName); },
        log: request.log,
        run: () => restoreContainerBackup(plan),
      });
      return reply.code(202).send(job);
    },
  });

  // POST /container-backups/restore-in-place — restore a backup over the live
  // container it was taken from (same name/MAC/lease). One job, its optional
  // safety backup first; `done` is `{ name, image }`.
  fastify.post('/container-backups/restore-in-place', {
    config: { auth: 'admin' },
    schema: {
      body: {
        type: 'object',
        required: ['destinationId', 'name', 'timestamp'],
        properties: {
          destinationId: { type: 'string' },
          name: { type: 'string' },
          timestamp: { type: 'string' },
          safetyBackup: { type: 'boolean', default: true },
        },
        additionalProperties: false,
      },
      response: {
        202: jobAckSchema,
      },
    },
    handler: async (request, reply) => {
      const { destinationId, name, timestamp, safetyBackup = true } = request.body;
      validateContainerName(name);
      assertSafeTimestamp(timestamp);

      const settings = await getSettings();
      const rawMounts = await getRawMounts();
      const [dest] = await resolveBackupDestinations(settings, rawMounts, [destinationId]);
      const backupPath = join(dest.path, 'containers', name, timestamp);

      // Held for the whole job (safety backup included): no start, backup,
      // edit or second restore of the container while its files are replaced.
      const job = await startJob({
        kind: BACKGROUND_JOB_KIND.CONTAINER_RESTORE,
        title: titleForContainerRestore(name),
        subject: { type: 'container', name },
        // Fail fast in the request (the manager re-checks inside the job).
        check: async () => {
          const container = (await listContainers()).find((c) => c.name === name);
          if (!container) {
            throw createAppError('CONTAINER_NOT_FOUND', `Container "${name}" not found — restore the backup as a new container instead`);
          }
          if (container.state !== 'stopped' && container.state !== 'created') {
            throw createAppError('CONTAINER_MUST_BE_STOPPED', `Container "${name}" must be stopped to restore in place`);
          }
        },
        log: request.log,
        run: (report) => restoreContainerInPlace({
          name,
          dest,
          safetyBackup,
          runSafetyBackup: (onProgress) => createContainerBackup(name, dest.path, { origin: 'manual', onProgress }),
          runRestore: (onProgress) => restoreContainerBackupInPlace(backupPath, { onProgress }),
          report,
        }),
      });
      return reply.code(202).send(job);
    },
  });

  fastify.delete('/container-backups', {
    config: { auth: 'admin' },
    schema: {
      body: {
        type: 'object',
        required: ['destinationId', 'name', 'timestamp'],
        properties: {
          destinationId: { type: 'string' },
          name: { type: 'string' },
          timestamp: { type: 'string' },
        },
        additionalProperties: false,
      },
      response: { 204: { type: 'null' } },
    },
    handler: async (request, reply) => {
      const { destinationId, name, timestamp } = request.body || {};
      validateContainerName(name);
      assertSafeTimestamp(timestamp);
      const settings = await getSettings();
      const root = resolveBackupRoot(settings, destinationId);
      const backupPath = join(root, 'containers', name, timestamp);
      const roots = listConfiguredBackupRoots(settings);
      await deleteContainerBackup(backupPath, roots);
      return reply.code(204).send();
    },
  });
}
