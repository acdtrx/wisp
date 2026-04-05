import { realpath } from 'node:fs/promises';

import { listBackups, restoreBackup, deleteBackup } from '../lib/vmManager.js';
import { getSettings, listConfiguredBackupRoots, listBackupDestinationsWithMountCheck } from '../lib/settings.js';
import { createAppError, handleRouteError } from '../lib/routeErrors.js';
import { validateVMName } from '../lib/validation.js';

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
