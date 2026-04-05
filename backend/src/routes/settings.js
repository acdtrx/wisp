import {
  getSettings, updateSettings, getRawNetworkMounts,
  addNetworkMount, updateNetworkMount, removeNetworkMount,
} from '../lib/settings.js';
import { mountSMB, unmountSMB, getMountStatus, checkSMBConnection } from '../lib/smbMount.js';
import { handleRouteError, sendError } from '../lib/routeErrors.js';

const mountSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    label: { type: 'string' },
    path: { type: 'string' },
    mountPath: { type: 'string' },
    share: { type: 'string' },
    username: { type: 'string' },
    password: { type: 'string' },
  },
};

const settingsResponseProps = {
  serverName: { type: 'string' },
  vmsPath: { type: 'string' },
  imagePath: { type: 'string' },
  refreshIntervalSeconds: { type: 'integer' },
  backupLocalPath: { type: 'string' },
  containersPath: { type: 'string' },
  networkMounts: { type: 'array', items: mountSchema },
  backupNetworkMountId: { type: ['string', 'null'] },
};

export default async function settingsRoutes(fastify) {
  fastify.get('/settings', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: settingsResponseProps,
        },
      },
    },
    handler: async () => {
      return getSettings();
    },
  });

  fastify.patch('/settings', {
    schema: {
      body: {
        type: 'object',
        properties: {
          serverName: { type: ['string', 'null'] },
          refreshIntervalSeconds: { type: 'integer', minimum: 1, maximum: 60 },
          vmsPath: { type: 'string' },
          imagePath: { type: 'string' },
          backupLocalPath: { type: 'string' },
          containersPath: { type: 'string' },
          networkMounts: { type: 'array', items: mountSchema },
          backupNetworkMountId: { type: ['string', 'null'] },
        },
        additionalProperties: false,
      },
      response: {
        200: {
          type: 'object',
          properties: settingsResponseProps,
        },
      },
    },
    handler: async (request, reply) => {
      try {
        return await updateSettings(request.body || {});
      } catch (err) {
        fastify.log.error({ err }, 'Failed to update settings');
        sendError(reply, 500, 'Failed to save settings', err.message);
      }
    },
  });

  fastify.post('/settings/network-mounts', {
    schema: {
      body: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          share: { type: 'string' },
          path: { type: 'string' },
          mountPath: { type: 'string' },
          username: { type: 'string' },
          password: { type: 'string' },
        },
        additionalProperties: false,
      },
      response: {
        200: {
          type: 'object',
          properties: settingsResponseProps,
        },
      },
    },
    handler: async (request, reply) => {
      try {
        return await addNetworkMount(request.body || {});
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  fastify.patch('/settings/network-mounts/:id', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          share: { type: 'string' },
          path: { type: 'string' },
          mountPath: { type: 'string' },
          username: { type: 'string' },
          password: { type: 'string' },
        },
        additionalProperties: false,
      },
      response: {
        200: {
          type: 'object',
          properties: settingsResponseProps,
        },
      },
    },
    handler: async (request, reply) => {
      try {
        return await updateNetworkMount(request.params.id, request.body || {});
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  fastify.delete('/settings/network-mounts/:id', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      response: {
        200: {
          type: 'object',
          properties: settingsResponseProps,
        },
      },
    },
    handler: async (request, reply) => {
      try {
        return await removeNetworkMount(request.params.id);
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  fastify.get('/settings/network-mounts/status', {
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
        const settings = await getSettings();
        const mounts = (settings.networkMounts || []).filter((d) => d.share || d.mountPath);
        const result = [];
        for (const d of mounts) {
          const mountPath = d.mountPath || d.path;
          const { mounted } = await getMountStatus(mountPath);
          result.push({ id: d.id, label: d.label, mountPath, mounted });
        }
        return result;
      } catch (err) {
        fastify.log.error({ err }, 'Network mount status failed');
        sendError(reply, 500, 'Failed to get network mount status', err.message);
      }
    },
  });

  fastify.post('/settings/network-mounts/check', {
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
      response: {
        200: { type: 'object', properties: { ok: { type: 'boolean' } } },
      },
    },
    handler: async (request, reply) => {
      try {
        const body = request.body || {};
        let share = body.share;
        let username = body.username;
        let password = body.password;
        if (body.id) {
          const mounts = await getRawNetworkMounts();
          const d = mounts.find((x) => x.id === body.id);
          if (!d || !d.share) {
            return reply.code(404).send({ error: 'Network mount not found', detail: body.id });
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
        fastify.log.error({ err }, 'Network mount check failed');
        const detail = (err.stderr && String(err.stderr).trim()) || err.raw || err.detail || err.message;
        sendError(reply, 500, 'Network mount check failed', detail);
      }
    },
  });

  fastify.post('/settings/network-mounts/:id/mount', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } } } },
    },
    handler: async (request, reply) => {
      try {
        const mounts = await getRawNetworkMounts();
        const d = mounts.find((x) => x.id === request.params.id);
        if (!d || !d.share) {
          return reply.code(404).send({ error: 'Network mount not found', detail: request.params.id });
        }
        const mountPath = d.mountPath || d.path;
        await mountSMB(d.share, mountPath, { username: d.username, password: d.password });
        return { ok: true };
      } catch (err) {
        if (err.code === 'SMB_INVALID' || err.code === 'SMB_MOUNT_UNAVAILABLE') {
          return reply.code(503).send({ error: err.message, detail: err.raw || err.detail || err.message });
        }
        fastify.log.error({ err }, 'Network mount failed');
        sendError(reply, 500, 'Network mount failed', err.raw || err.detail || err.message);
      }
    },
  });

  fastify.post('/settings/network-mounts/:id/unmount', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } } } },
    },
    handler: async (request, reply) => {
      try {
        const settings = await getSettings();
        const d = (settings.networkMounts || []).find((x) => x.id === request.params.id);
        if (!d) {
          return reply.code(404).send({ error: 'Network mount not found', detail: request.params.id });
        }
        const mountPath = d.mountPath || d.path;
        await unmountSMB(mountPath);
        return { ok: true };
      } catch (err) {
        if (err.code === 'SMB_INVALID' || err.code === 'SMB_MOUNT_UNAVAILABLE') {
          return reply.code(503).send({ error: err.message, detail: err.raw || err.detail || err.message });
        }
        fastify.log.error({ err }, 'Network mount unmount failed');
        sendError(reply, 500, 'Network mount unmount failed', err.raw || err.detail || err.message);
      }
    },
  });
}
