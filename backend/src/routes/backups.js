import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import {
  listBackups,
  restoreBackup,
  restoreBackupInPlace,
  deleteBackup,
  resolveVmBackupDir,
  createBackup,
  listVMs,
} from '../lib/vmManager/index.js';
import {
  listContainerBackups,
  restoreContainerBackup,
  restoreContainerBackupInPlace,
  deleteContainerBackup,
  createContainerBackup,
  listContainers,
} from '../lib/containerManager/index.js';
import { getSettings, getRawMounts, listConfiguredBackupRoots, listBackupDestinationsWithMountCheck } from '../lib/settings.js';
import { resolveBackupDestinations } from '../lib/backupDestinations.js';
import { recordBackupAttempt, notifyBackupsChanged } from '../lib/backupStatus.js';
import {
  backupJobStore,
  BACKGROUND_JOB_KIND,
  titleForBackup,
  titleForContainerBackup,
  titleForVmRestore,
  titleForContainerRestore,
} from '../lib/jobs/index.js';
import { createAppError, handleRouteError } from '../lib/routeErrors.js';
import { validateVMName, validateContainerName } from '../lib/validation.js';

// Backup directory names produced by createBackup are ISO-derived
// (YYYY-MM-DDTHH-mm-ss). The accept-set is intentionally a bit looser to
// keep older folder formats listable/deletable; the strict character class
// is what blocks `..`, `/`, NUL, etc., so server-side path construction
// cannot escape the chosen destination root.
const TIMESTAMP_REGEX = /^[A-Za-z0-9._-]+$/;
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
 * Run an in-place restore as a background job in the shared backupJobStore:
 * optional safety backup of the current state first (0–45% of the bar), then
 * the restore itself (45–100%). The safety phase's step names are prefixed
 * `safety-` so its terminal `done` event can't end the job stream early.
 *
 * @param {object} opts
 * @param {string} opts.jobId
 * @param {'vm' | 'container'} opts.kind - workload kind for the attempt record
 * @param {string} opts.name - workload name
 * @param {{ id: string, path: string }} opts.dest - resolved destination (safety backup target)
 * @param {boolean} opts.safetyBackup
 * @param {(onProgress: (ev: object) => void) => Promise<object>} opts.runSafetyBackup
 * @param {(onProgress: (ev: object) => void) => Promise<object>} opts.runRestore
 * @param {import('fastify').FastifyBaseLogger} opts.log
 */
function startRestoreInPlaceJob({ jobId, kind, name, dest, safetyBackup, runSafetyBackup, runRestore, log }) {
  const scaledProgress = (base, span, stepPrefix = '') => (ev) => {
    backupJobStore.pushEvent(jobId, {
      step: `${stepPrefix}${ev.step}`,
      percent: ev.percent != null ? Math.min(100, Math.round(base + (ev.percent / 100) * span)) : undefined,
      currentFile: ev.currentFile,
    });
  };

  (async () => {
    if (safetyBackup) {
      try {
        const res = await runSafetyBackup(scaledProgress(0, 45, 'safety-'));
        await recordBackupAttempt({
          kind, name, ok: true, origin: 'manual', destinationIds: [dest.id], timestamp: res?.timestamp,
        });
      } catch (err) {
        await recordBackupAttempt({
          kind, name, ok: false, origin: 'manual', destinationIds: [dest.id], error: err?.message,
        });
        /* Safety backup failed — abort before touching the live workload. */
        throw err;
      }
    }
    const result = await runRestore(scaledProgress(safetyBackup ? 45 : 0, safetyBackup ? 55 : 100));
    backupJobStore.completeJob(jobId, result);
  })().catch((err) => {
    backupJobStore.failJob(jobId, err);
    log.error({ err, jobId }, 'Background restore-in-place job failed');
  });
}

/** 409 when a backup or restore job for the same workload is already running. */
function assertNoActiveBackupJob({ backupKind, backupTitle, restoreKind, restoreTitle }) {
  const active = backupJobStore.listJobs().some((j) => !j.done && (
    (j.kind === backupKind && j.title === backupTitle) ||
    (j.kind === restoreKind && j.title === restoreTitle)
  ));
  if (active) {
    throw createAppError(
      'BACKUP_IN_PROGRESS',
      'A backup or restore is already running',
      `A backup or restore job for this workload is already in progress`,
    );
  }
}

export default async function backupsRoutes(fastify) {
  // GET /backups — list backups from configured destinations; optional ?vmName= filter
  fastify.get('/backups', {
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
    handler: async (request, reply) => {
      try {
        const settings = await getSettings();
        const destinations = await listBackupDestinationsWithMountCheck(settings);
        const vmName = request.query?.vmName ?? null;
        const list = await listBackups(destinations, vmName || undefined);
        return list.map(stripPath);
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  // POST /backups/restore — restore backup as new VM
  fastify.post('/backups/restore', {
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
        200: {
          type: 'object',
          properties: { name: { type: 'string' } },
        },
      },
    },
    handler: async (request, reply) => {
      try {
        const { destinationId, vmName, timestamp, newVmName } = request.body;
        validateVMName(vmName);
        validateVMName(newVmName);
        assertSafeTimestamp(timestamp);
        const settings = await getSettings();
        const root = resolveBackupRoot(settings, destinationId);
        const backupPath = await resolveVmBackupDir(root, vmName, timestamp);
        return await restoreBackup(backupPath, newVmName);
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  // POST /backups/restore-in-place — restore a backup over the live VM it was
  // taken from. Runs as a background job (progress via /vms/backup-progress/:jobId)
  // with an optional safety backup of the current state first (default on).
  fastify.post('/backups/restore-in-place', {
    schema: {
      body: {
        type: 'object',
        required: ['destinationId', 'vmName', 'timestamp'],
        properties: {
          destinationId: { type: 'string' },
          vmName: { type: 'string' },
          timestamp: { type: 'string' },
          safetyBackup: { type: 'boolean', default: true },
        },
        additionalProperties: false,
      },
      response: {
        201: {
          type: 'object',
          properties: {
            jobId: { type: 'string' },
            title: { type: 'string' },
          },
        },
      },
    },
    handler: async (request, reply) => {
      try {
        const { destinationId, vmName, timestamp, safetyBackup = true } = request.body;
        validateVMName(vmName);
        assertSafeTimestamp(timestamp);

        const settings = await getSettings();
        const rawMounts = await getRawMounts();
        const [dest] = await resolveBackupDestinations(settings, rawMounts, [destinationId]);
        const backupPath = await resolveVmBackupDir(dest.path, vmName, timestamp);

        /* Fail fast in the request (the manager re-checks inside the job). */
        const vm = (await listVMs()).find((v) => v.name === vmName);
        if (!vm) {
          throw createAppError('VM_NOT_FOUND', `VM "${vmName}" not found — restore the backup as a new VM instead`);
        }
        if (vm.stateCode !== 5 && vm.stateCode !== 4) {
          throw createAppError('VM_MUST_BE_OFFLINE', `VM "${vmName}" must be stopped to restore in place`);
        }

        const title = titleForVmRestore(vmName);
        assertNoActiveBackupJob({
          backupKind: BACKGROUND_JOB_KIND.BACKUP,
          backupTitle: titleForBackup(vmName),
          restoreKind: BACKGROUND_JOB_KIND.VM_RESTORE,
          restoreTitle: title,
        });

        const jobId = randomBytes(12).toString('hex');
        backupJobStore.createJob(jobId, { kind: BACKGROUND_JOB_KIND.VM_RESTORE, title, log: request.log });
        request.log.info({ jobId, kind: BACKGROUND_JOB_KIND.VM_RESTORE, title }, 'Background job started');
        startRestoreInPlaceJob({
          jobId,
          kind: 'vm',
          name: vmName,
          dest,
          safetyBackup,
          runSafetyBackup: (onProgress) => createBackup(vmName, dest.path, { onProgress }),
          runRestore: (onProgress) => restoreBackupInPlace(backupPath, { onProgress }),
          log: request.log,
        });
        return reply.code(201).send({ jobId, title });
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  // DELETE /backups — delete a VM backup
  fastify.delete('/backups', {
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
      response: {
        200: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
        },
      },
    },
    handler: async (request, reply) => {
      try {
        const { destinationId, vmName, timestamp } = request.body;
        validateVMName(vmName);
        assertSafeTimestamp(timestamp);
        const settings = await getSettings();
        const root = resolveBackupRoot(settings, destinationId);
        const backupPath = await resolveVmBackupDir(root, vmName, timestamp);
        const roots = listConfiguredBackupRoots(settings);
        await deleteBackup(backupPath, roots);
        notifyBackupsChanged();
        return { ok: true };
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  // ── Container backups ──────────────────────────────────────────
  // Parallel API to /backups for containers. Container backups live under
  // <dest>/containers/<name>/<timestamp>/ so VM and container backups can
  // never collide on identical names.

  fastify.get('/container-backups', {
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
    handler: async (request, reply) => {
      try {
        const settings = await getSettings();
        const destinations = await listBackupDestinationsWithMountCheck(settings);
        const containerName = request.query?.containerName ?? null;
        const list = await listContainerBackups(destinations, containerName || undefined);
        return list.map(stripPath);
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  fastify.post('/container-backups/restore', {
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
        200: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            sourceName: { type: 'string' },
            image: { type: ['string', 'null'] },
          },
        },
      },
    },
    handler: async (request, reply) => {
      try {
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
        return await restoreContainerBackup(backupPath, newName);
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  // POST /container-backups/restore-in-place — restore a backup over the live
  // container it was taken from (same name/MAC/lease). Background job with an
  // optional safety backup first; progress via /containers/backup-progress/:jobId.
  fastify.post('/container-backups/restore-in-place', {
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
        201: {
          type: 'object',
          properties: {
            jobId: { type: 'string' },
            title: { type: 'string' },
          },
        },
      },
    },
    handler: async (request, reply) => {
      try {
        const { destinationId, name, timestamp, safetyBackup = true } = request.body;
        validateContainerName(name);
        assertSafeTimestamp(timestamp);

        const settings = await getSettings();
        const rawMounts = await getRawMounts();
        const [dest] = await resolveBackupDestinations(settings, rawMounts, [destinationId]);
        const backupPath = join(dest.path, 'containers', name, timestamp);

        /* Fail fast in the request (the manager re-checks inside the job). */
        const container = (await listContainers()).find((c) => c.name === name);
        if (!container) {
          throw createAppError('CONTAINER_NOT_FOUND', `Container "${name}" not found — restore the backup as a new container instead`);
        }
        if (container.state !== 'stopped' && container.state !== 'created') {
          throw createAppError('CONTAINER_MUST_BE_STOPPED', `Container "${name}" must be stopped to restore in place`);
        }

        const title = titleForContainerRestore(name);
        assertNoActiveBackupJob({
          backupKind: BACKGROUND_JOB_KIND.CONTAINER_BACKUP,
          backupTitle: titleForContainerBackup(name),
          restoreKind: BACKGROUND_JOB_KIND.CONTAINER_RESTORE,
          restoreTitle: title,
        });

        const jobId = randomBytes(12).toString('hex');
        backupJobStore.createJob(jobId, { kind: BACKGROUND_JOB_KIND.CONTAINER_RESTORE, title, log: request.log });
        request.log.info({ jobId, kind: BACKGROUND_JOB_KIND.CONTAINER_RESTORE, title }, 'Background job started');
        startRestoreInPlaceJob({
          jobId,
          kind: 'container',
          name,
          dest,
          safetyBackup,
          runSafetyBackup: (onProgress) => createContainerBackup(name, dest.path, { origin: 'manual', onProgress }),
          runRestore: (onProgress) => restoreContainerBackupInPlace(backupPath, { onProgress }),
          log: request.log,
        });
        return reply.code(201).send({ jobId, title });
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  fastify.delete('/container-backups', {
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
      response: {
        200: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
        },
      },
    },
    handler: async (request, reply) => {
      try {
        const { destinationId, name, timestamp } = request.body || {};
        validateContainerName(name);
        assertSafeTimestamp(timestamp);
        const settings = await getSettings();
        const root = resolveBackupRoot(settings, destinationId);
        const backupPath = join(root, 'containers', name, timestamp);
        const roots = listConfiguredBackupRoots(settings);
        await deleteContainerBackup(backupPath, roots);
        notifyBackupsChanged();
        return { ok: true };
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });
}
