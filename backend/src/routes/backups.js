import { join } from 'node:path';

import {
  listBackups,
  deleteBackup,
  resolveVmBackupDir,
} from '../lib/vmManager/index.js';
import {
  listContainerBackups,
  deleteContainerBackup,
} from '../lib/containerManager/index.js';
import { getSettings, listConfiguredBackupRoots, listBackupDestinationsWithMountCheck } from '../lib/settings.js';
import { startVmRestoreJob } from '../lib/vmOperations.js';
import { startContainerRestoreJob, startContainerRestoreAsNewJob } from '../lib/containerOperations.js';
import { createAppError } from '../lib/appErrors.js';
import { containerNameSchema, vmNameSchema } from '../lib/validation.js';
import { jobAckSchema, noContentSchema } from './schemas.js';

/*
 * A backup's folder name. Those createBackup writes are ISO-derived
 * (YYYY-MM-DDTHH-mm-ss); the accept-set is a bit looser to keep older folder
 * formats listable and deletable. The character class blocks `/`, `\`, NUL
 * and the like; the leading alphanumeric blocks `.` and `..`, so the
 * timestamp is always a single child segment and the path built from it
 * cannot resolve to (or above) the destination root.
 */
const timestampSchema = { type: 'string', maxLength: 64, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' };

/** `local` or the backup mount's id. */
const destinationIdSchema = { type: 'string', minLength: 1 };

// Map a client-supplied `destinationId` ('local' | <mountId>) to the absolute
// root path the backup lives under. Anything else is rejected.
function resolveBackupRoot(settings, destinationId) {
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

export default async function backupsRoutes(fastify) {
  // GET /backups — list backups from configured destinations; optional ?vmName= filter
  fastify.get('/backups', {
    config: { auth: 'read' },
    schema: {
      querystring: {
        type: 'object',
        properties: { vmName: vmNameSchema },
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
      const list = await listBackups(destinations, request.query.vmName);
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
          destinationId: destinationIdSchema,
          vmName: vmNameSchema,
          timestamp: timestampSchema,
          newVmName: vmNameSchema,
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
      const settings = await getSettings();
      const root = resolveBackupRoot(settings, destinationId);
      const backupPath = await resolveVmBackupDir(root, vmName, timestamp);
      const job = await startVmRestoreJob({ backupPath, newName: newVmName, log: request.log });
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
          destinationId: destinationIdSchema,
          vmName: vmNameSchema,
          timestamp: timestampSchema,
        },
        additionalProperties: false,
      },
      response: { 204: noContentSchema },
    },
    handler: async (request, reply) => {
      const { destinationId, vmName, timestamp } = request.body;
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
        properties: { containerName: containerNameSchema },
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
      const list = await listContainerBackups(destinations, request.query.containerName);
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
          destinationId: destinationIdSchema,
          name: containerNameSchema,
          timestamp: timestampSchema,
          newName: containerNameSchema,
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
      const settings = await getSettings();
      const root = resolveBackupRoot(settings, destinationId);
      // Containers live under <root>/containers/<name>/<timestamp>/. The
      // route knows the layout because it owns the API contract; the
      // container manager keeps generic "absolute path in" semantics.
      const backupPath = join(root, 'containers', name, timestamp);
      const job = await startContainerRestoreAsNewJob({ backupPath, newName, log: request.log });
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
          destinationId: destinationIdSchema,
          name: containerNameSchema,
          timestamp: timestampSchema,
          safetyBackup: { type: 'boolean', default: true },
        },
        additionalProperties: false,
      },
      response: {
        202: jobAckSchema,
      },
    },
    handler: async (request, reply) => {
      const { destinationId, name, timestamp, safetyBackup } = request.body;
      const job = await startContainerRestoreJob({
        name, destinationId, timestamp, safetyBackup, log: request.log,
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
          destinationId: destinationIdSchema,
          name: containerNameSchema,
          timestamp: timestampSchema,
        },
        additionalProperties: false,
      },
      response: { 204: noContentSchema },
    },
    handler: async (request, reply) => {
      const { destinationId, name, timestamp } = request.body;
      const settings = await getSettings();
      const root = resolveBackupRoot(settings, destinationId);
      const backupPath = join(root, 'containers', name, timestamp);
      const roots = listConfiguredBackupRoots(settings);
      await deleteContainerBackup(backupPath, roots);
      return reply.code(204).send();
    },
  });
}
