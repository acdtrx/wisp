import { realpath } from 'node:fs/promises';

import { listBackups, restoreBackup, deleteBackup } from '../lib/vmManager.js';
import {
  listContainerBackups,
  restoreContainerBackup,
  deleteContainerBackup,
} from '../lib/containerManager.js';
import { getSettings, listConfiguredBackupRoots, listBackupDestinationsWithMountCheck } from '../lib/settings.js';
import { createAppError, handleRouteError } from '../lib/routeErrors.js';
import { validateVMName, validateContainerName } from '../lib/validation.js';

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
              path: { type: 'string' },
              sizeBytes: { type: 'number' },
              destinationLabel: { type: 'string' },
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
        return list;
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
        required: ['backupPath', 'newVmName'],
        properties: {
          backupPath: { type: 'string' },
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
        validateVMName(request.body.newVmName);
        const { backupPath, newVmName } = request.body;
        const settings = await getSettings();
        const roots = listConfiguredBackupRoots(settings);
        const normalized = (backupPath || '').replace(/\/+$/, '') || backupPath;
        if (!normalized || !normalized.startsWith('/')) {
          throw createAppError('BACKUP_INVALID', 'Invalid backup path');
        }
        let resolvedBackup;
        try {
          resolvedBackup = await realpath(normalized);
        } catch (err) {
          if (err.code === 'ENOENT') throw createAppError('BACKUP_NOT_FOUND', 'Backup not found');
          throw createAppError('BACKUP_INVALID', 'Cannot resolve backup path', err.message);
        }
        const resolvedRoots = await Promise.all(
          roots.map((r) =>
            realpath((r || '').replace(/\/+$/, '') || r).catch(() => {
              /* configured root missing or not resolvable */
              return null;
            })
          )
        );
        const underRoot = resolvedRoots.some(
          (resolvedRoot) =>
            resolvedRoot &&
            (resolvedBackup === resolvedRoot || resolvedBackup.startsWith(resolvedRoot + '/'))
        );
        if (!underRoot) {
          throw createAppError('BACKUP_INVALID', 'Backup path is not under a configured destination');
        }
        const result = await restoreBackup(resolvedBackup, newVmName);
        return result;
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
              path: { type: 'string' },
              sizeBytes: { type: 'number' },
              destinationLabel: { type: 'string' },
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
        return await listContainerBackups(destinations, containerName || undefined);
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  fastify.post('/container-backups/restore', {
    schema: {
      body: {
        type: 'object',
        required: ['backupPath', 'newName'],
        properties: {
          backupPath: { type: 'string' },
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
        validateContainerName(request.body.newName);
        const { backupPath, newName } = request.body;
        const settings = await getSettings();
        const roots = listConfiguredBackupRoots(settings);
        const normalized = (backupPath || '').replace(/\/+$/, '') || backupPath;
        if (!normalized || !normalized.startsWith('/')) {
          throw createAppError('BACKUP_INVALID', 'Invalid backup path');
        }
        let resolvedBackup;
        try {
          resolvedBackup = await realpath(normalized);
        } catch (err) {
          if (err.code === 'ENOENT') throw createAppError('BACKUP_NOT_FOUND', 'Backup not found');
          throw createAppError('BACKUP_INVALID', 'Cannot resolve backup path', err.message);
        }
        const resolvedRoots = await Promise.all(
          roots.map((r) =>
            realpath((r || '').replace(/\/+$/, '') || r).catch(() => null),
          ),
        );
        const underRoot = resolvedRoots.some(
          (resolvedRoot) =>
            resolvedRoot
            && (resolvedBackup === resolvedRoot || resolvedBackup.startsWith(`${resolvedRoot}/`)),
        );
        if (!underRoot) {
          throw createAppError('BACKUP_INVALID', 'Backup path is not under a configured destination');
        }
        return await restoreContainerBackup(resolvedBackup, newName);
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  fastify.delete('/container-backups', {
    schema: {
      body: {
        type: 'object',
        required: ['backupPath'],
        properties: { backupPath: { type: 'string' } },
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
        const { backupPath } = request.body || {};
        const settings = await getSettings();
        const roots = listConfiguredBackupRoots(settings);
        await deleteContainerBackup(backupPath, roots);
        return { ok: true };
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  // DELETE /backups — delete a backup (path must be under a configured destination)
  fastify.delete('/backups', {
    schema: {
      body: {
        type: 'object',
        required: ['backupPath'],
        properties: {
          backupPath: { type: 'string' },
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
        const { backupPath } = request.body || {};
        const settings = await getSettings();
        const roots = listConfiguredBackupRoots(settings);
        await deleteBackup(backupPath, roots);
        return { ok: true };
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });
}
