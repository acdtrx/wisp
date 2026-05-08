import { join } from 'node:path';

import { listBackups, restoreBackup, deleteBackup } from '../lib/vmManager/index.js';
import {
  listContainerBackups,
  restoreContainerBackup,
  deleteContainerBackup,
} from '../lib/containerManager/index.js';
import { getSettings, listConfiguredBackupRoots, listBackupDestinationsWithMountCheck } from '../lib/settings.js';
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
        const backupPath = join(root, vmName, timestamp);
        return await restoreBackup(backupPath, newVmName);
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
        const backupPath = join(root, vmName, timestamp);
        const roots = listConfiguredBackupRoots(settings);
        await deleteBackup(backupPath, roots);
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
        return { ok: true };
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });
}
