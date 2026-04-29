import {
  getSettings,
  getRawMounts,
  addMount,
  updateMount,
  removeMount,
} from '../lib/settings.js';
import { mountSMB, unmountSMB, getMountStatus, checkSMBConnection, rmdirMountpoint } from '../lib/smbMount.js';
import { mountDisk, unmountDisk } from '../lib/diskMount.js';
import { refresh as refreshDiskSnapshot, getDevices as getDiskDevices } from '../lib/diskMonitor.js';
import { findContainersUsingStorageMount } from '../lib/containerManager.js';
import { handleRouteError, sendError } from '../lib/routeErrors.js';

/* Response schema deliberately omits `password`: the field never leaves the
 * server. `mountForApi` (settings.js) replaces it with `hasPassword: boolean`
 * so the UI can render a "saved" affordance without holding a secret-shaped
 * placeholder string. Declaring the schema here means Fastify strips any
 * stray `password` even if a future change leaks it back into the model. */
const mountResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    type: { type: 'string' },
    label: { type: 'string' },
    mountPath: { type: 'string' },
    autoMount: { type: 'boolean' },
    share: { type: 'string' },
    username: { type: 'string' },
    hasPassword: { type: 'boolean' },
    uuid: { type: 'string' },
    fsType: { type: 'string' },
    readOnly: { type: 'boolean' },
  },
};

export default async function mountsRoutes(fastify) {
  fastify.get('/host/mounts', {
    schema: {
      response: { 200: { type: 'array', items: mountResponseSchema } },
    },
    handler: async () => {
      const settings = await getSettings();
      return settings.mounts || [];
    },
  });

  fastify.post('/host/mounts', {
    schema: {
      body: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          type: { type: 'string', enum: ['smb', 'disk'] },
          label: { type: 'string' },
          mountPath: { type: 'string' },
          autoMount: { type: 'boolean' },
          share: { type: 'string' },
          username: { type: 'string' },
          password: { type: 'string' },
          uuid: { type: 'string' },
          fsType: { type: 'string' },
          readOnly: { type: 'boolean' },
        },
        required: ['type', 'mountPath'],
        additionalProperties: false,
      },
    },
    handler: async (request, reply) => {
      try {
        const result = await addMount(request.body || {});
        const created = (result.mounts || []).find((m) => {
          if (request.body?.id) return m.id === request.body.id;
          if (request.body?.type === 'disk' && request.body?.uuid) return m.uuid === request.body.uuid;
          if (request.body?.type === 'smb' && request.body?.share) return m.share === request.body.share && m.mountPath === request.body.mountPath;
          return false;
        });
        if (created && created.type === 'disk' && created.autoMount !== false) {
          const devices = getDiskDevices();
          const present = devices.find((d) => d.uuid === created.uuid);
          if (present && !present.mountedAt) {
            try {
              await mountDisk(created.uuid, created.mountPath, { fsType: created.fsType, readOnly: created.readOnly });
              refreshDiskSnapshot();
            } catch (err) {
              request.log.warn({ err, id: created.id }, 'Auto-mount on adopt failed — settings saved, mount can be triggered manually');
            }
          }
        }
        return result.mounts || [];
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  fastify.patch('/host/mounts/:id', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          mountPath: { type: 'string' },
          autoMount: { type: 'boolean' },
          share: { type: 'string' },
          username: { type: 'string' },
          password: { type: 'string' },
          fsType: { type: 'string' },
          readOnly: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
    handler: async (request, reply) => {
      try {
        const result = await updateMount(request.params.id, request.body || {});
        return result.mounts || [];
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  fastify.delete('/host/mounts/:id', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    handler: async (request, reply) => {
      try {
        const mounts = await getRawMounts();
        const d = mounts.find((x) => x.id === request.params.id);
        if (!d) {
          return reply.code(404).send({ error: 'Mount not found', detail: request.params.id });
        }
        /* Refuse if any container's mounts[*].sourceId references this id —
         * removing it would leave the container with a dangling source on
         * next start. Mirrors assertBridgeNotInUse / findVMsUsingImage. */
        const inUseBy = await findContainersUsingStorageMount(d.id);
        if (inUseBy.length > 0) {
          return reply.code(409).send({
            error: 'Mount in use',
            detail: `Detach this mount from containers first: ${inUseBy.join(', ')}`,
          });
        }
        /* Best-effort unmount before we forget about it; both flavours also rmdir /mnt/wisp/<name>
         * separately (delete-only cleanup — regular unmount leaves the dir in place). */
        try {
          if (d.type === 'disk') {
            await unmountDisk(d.mountPath, { ignoreNotMounted: true });
          } else {
            await unmountSMB(d.mountPath, { ignoreNotMounted: true });
          }
        } catch (err) {
          /* Log but continue with the delete — the user is telling us to forget this entry. */
          request.log.warn({ err, id: d.id, mountPath: d.mountPath }, 'Unmount before delete failed; removing entry anyway');
        }
        try {
          await rmdirMountpoint(d.mountPath);
        } catch (err) {
          /* Non-fatal — leaves a stale empty dir the user can clean up, but the config entry is gone. */
          request.log.warn({ err, mountPath: d.mountPath }, 'Mount point rmdir failed on delete');
        }
        const result = await removeMount(request.params.id);
        if (d.type === 'disk') refreshDiskSnapshot();
        return result.mounts || [];
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  fastify.get('/host/mounts/status', {
    schema: {
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
              mountPath: { type: 'string' },
              mounted: { type: 'boolean' },
            },
          },
        },
      },
    },
    handler: async (request, reply) => {
      try {
        const mounts = await getRawMounts();
        const result = [];
        for (const d of mounts) {
          const { mounted } = await getMountStatus(d.mountPath);
          result.push({ id: d.id, label: d.label, mountPath: d.mountPath, mounted });
        }
        return result;
      } catch (err) {
        fastify.log.error({ err }, 'Mount status failed');
        sendError(reply, 500, 'Failed to get mount status', err.message);
      }
    },
  });

  fastify.post('/host/mounts/check', {
    schema: {
      body: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          share: { type: 'string' },
          username: { type: 'string' },
          password: { type: 'string' },
        },
        additionalProperties: false,
      },
      response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } } } },
    },
    handler: async (request, reply) => {
      try {
        const body = request.body || {};
        let share = body.share;
        let username = body.username;
        let password = body.password;
        if (body.id) {
          const mounts = await getRawMounts();
          const d = mounts.find((x) => x.id === body.id);
          if (!d || d.type !== 'smb') {
            return reply.code(404).send({ error: 'SMB mount not found', detail: body.id });
          }
          share = d.share;
          username = d.username;
          password = d.password;
        }
        if (!share || !share.trim()) {
          return reply.code(400).send({ error: 'Share is required', detail: 'Provide share or id' });
        }
        await checkSMBConnection(share, { username, password });
        return { ok: true };
      } catch (err) {
        if (err.code === 'SMB_INVALID' || err.code === 'SMB_MOUNT_UNAVAILABLE') {
          return reply.code(503).send({ error: err.message, detail: err.raw || err.detail || err.message });
        }
        fastify.log.error({ err }, 'Mount check failed');
        const detail = (err.stderr && String(err.stderr).trim()) || err.raw || err.detail || err.message;
        sendError(reply, 500, 'Mount check failed', detail);
      }
    },
  });

  fastify.post('/host/mounts/:id/mount', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } } } },
    },
    handler: async (request, reply) => {
      try {
        const mounts = await getRawMounts();
        const d = mounts.find((x) => x.id === request.params.id);
        if (!d) {
          return reply.code(404).send({ error: 'Mount not found', detail: request.params.id });
        }
        if (d.type === 'smb') {
          await mountSMB(d.share, d.mountPath, { username: d.username, password: d.password });
          return { ok: true };
        }
        if (d.type === 'disk') {
          await mountDisk(d.uuid, d.mountPath, { fsType: d.fsType, readOnly: d.readOnly });
          refreshDiskSnapshot();
          return { ok: true };
        }
        return reply.code(422).send({ error: 'Unknown mount type', detail: d.type });
      } catch (err) {
        if (
          err.code === 'SMB_INVALID' ||
          err.code === 'SMB_MOUNT_UNAVAILABLE' ||
          err.code === 'DISK_MOUNT_UNAVAILABLE'
        ) {
          return reply.code(503).send({ error: err.message, detail: err.raw || err.detail || err.message });
        }
        if (err.code === 'DISK_MOUNT_INVALID') {
          return reply.code(422).send({ error: err.message, detail: err.raw || err.detail || err.message });
        }
        fastify.log.error({ err }, 'Mount failed');
        sendError(reply, 500, 'Mount failed', err.raw || err.detail || err.message);
      }
    },
  });

  fastify.post('/host/mounts/:id/unmount', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } } } },
    },
    handler: async (request, reply) => {
      try {
        const mounts = await getRawMounts();
        const d = mounts.find((x) => x.id === request.params.id);
        if (!d) {
          return reply.code(404).send({ error: 'Mount not found', detail: request.params.id });
        }
        if (d.type === 'disk') {
          await unmountDisk(d.mountPath);
          refreshDiskSnapshot();
        } else {
          await unmountSMB(d.mountPath);
        }
        return { ok: true };
      } catch (err) {
        if (
          err.code === 'SMB_INVALID' ||
          err.code === 'SMB_MOUNT_UNAVAILABLE' ||
          err.code === 'DISK_MOUNT_UNAVAILABLE'
        ) {
          return reply.code(503).send({ error: err.message, detail: err.raw || err.detail || err.message });
        }
        fastify.log.error({ err }, 'Unmount failed');
        sendError(reply, 500, 'Unmount failed', err.raw || err.detail || err.message);
      }
    },
  });
}
