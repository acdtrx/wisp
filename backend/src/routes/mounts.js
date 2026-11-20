import {
  getSettings,
  getRawMounts,
  addMount,
  updateMount,
  removeMount,
} from '../lib/settings.js';
import {
  mountSMB, unmountSMB, getMountStatus, checkSMBConnection, rmdirMountpoint,
  mountDisk, unmountDisk,
  refresh as refreshDiskSnapshot, getDevices as getDiskDevices,
} from '../lib/storage/index.js';
import { findContainersUsingStorageMount } from '../lib/containerManager/index.js';
import { asAppError, createAppError } from '../lib/appErrors.js';
import { startJob, BACKGROUND_JOB_KIND, titleForUnmount, titleForMountDelete } from '../lib/jobs/index.js';

const JOB_ACCEPTED = {
  202: { type: 'object', properties: { jobId: { type: 'string' }, title: { type: 'string' } } },
};

/* Response schema deliberately omits `password`: the field never leaves the
 * server. `mountForApi` (settings.js) replaces it with `hasPassword: boolean`
 * so the UI can render a "saved" affordance without holding a secret-shaped
 * placeholder string. Declaring the schema here means Fastify strips any
 * stray `password` even if a future change leaks it back into the model.
 * Shared with `GET/PATCH /api/settings`, which return the same mount list. */
export const mountResponseSchema = {
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
    config: { auth: 'read' },
    schema: {
      response: { 200: { type: 'array', items: mountResponseSchema } },
    },
    handler: async () => {
      const settings = await getSettings();
      return settings.mounts || [];
    },
  });

  fastify.post('/host/mounts', {
    config: { auth: 'admin' },
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
      response: { 201: { type: 'object', properties: { id: { type: 'string' } } } },
    },
    handler: async (request, reply) => {
      const result = await addMount(request.body || {});
      const created = (result.mounts || []).find((m) => m.id === result.id);
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
      return reply.code(201).send({ id: result.id });
    },
  });

  fastify.patch('/host/mounts/:id', {
    config: { auth: 'admin' },
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
      response: { 204: { type: 'null' } },
    },
    handler: async (request, reply) => {
      await updateMount(request.params.id, request.body || {});
      return reply.code(204).send();
    },
  });

  // A job: it unmounts first, which may flush for a while. Not found (404) and
  // in use by a container (409) are answered here; the remaining mounts list is
  // the job's `done` payload (`{ mounts }`).
  fastify.delete('/host/mounts/:id', {
    config: { auth: 'admin' },
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      response: JOB_ACCEPTED,
    },
    handler: async (request, reply) => {
      const mounts = await getRawMounts();
      const d = mounts.find((x) => x.id === request.params.id);
      if (!d) {
        throw createAppError('MOUNT_NOT_FOUND', `No mount with id "${request.params.id}"`);
      }
      /* Refuse if any container's mounts[*].sourceId references this id —
       * removing it would leave the container with a dangling source on
       * next start. Mirrors assertBridgeNotInUse / findVMsUsingImage. */
      const inUseBy = await findContainersUsingStorageMount(d.id);
      if (inUseBy.length > 0) {
        throw createAppError('MOUNT_IN_USE', `Detach this mount from containers first: ${inUseBy.join(', ')}`);
      }
      const job = await startJob({
        kind: BACKGROUND_JOB_KIND.MOUNT_DELETE,
        title: titleForMountDelete(d.label || d.mountPath),
        log: request.log,
        run: async () => {
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
          const result = await removeMount(d.id);
          if (d.type === 'disk') refreshDiskSnapshot();
          return { mounts: result.mounts || [] };
        },
      });
      return reply.code(202).send(job);
    },
  });

  fastify.get('/host/mounts/status', {
    config: { auth: 'read' },
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
    handler: async () => {
      try {
        const mounts = await getRawMounts();
        const result = [];
        for (const d of mounts) {
          const { mounted } = await getMountStatus(d.mountPath);
          result.push({ id: d.id, label: d.label, mountPath: d.mountPath, mounted });
        }
        return result;
      } catch (err) {
        throw asAppError(err, 'Failed to get mount status');
      }
    },
  });

  fastify.post('/host/mounts/check', {
    config: { auth: 'admin' },
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
    handler: async (request) => {
      const body = request.body || {};
      let share = body.share;
      let username = body.username;
      let password = body.password;
      /* With an id, the saved mount supplies the credentials and any field
       * the body carries overrides it — an edit form tests its unsaved share
       * or username against the stored password without ever reading it. */
      if (body.id) {
        const mounts = await getRawMounts();
        const d = mounts.find((x) => x.id === body.id);
        if (!d || d.type !== 'smb') {
          throw createAppError('MOUNT_NOT_FOUND', `No SMB mount with id "${body.id}"`);
        }
        share = body.share ?? d.share;
        username = body.username ?? d.username;
        password = body.password ?? d.password;
      }
      if (!share || !share.trim()) {
        throw createAppError('VALIDATION_FAILED', 'body/share is required unless body/id names a saved SMB mount');
      }
      try {
        await checkSMBConnection(share, { username, password });
      } catch (err) {
        throw asAppError(err, 'SMB connection check failed');
      }
      return { ok: true };
    },
  });

  fastify.post('/host/mounts/:id/mount', {
    config: { auth: 'admin' },
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      response: { 204: { type: 'null' } },
    },
    handler: async (request, reply) => {
      const mounts = await getRawMounts();
      const d = mounts.find((x) => x.id === request.params.id);
      if (!d) {
        throw createAppError('MOUNT_NOT_FOUND', `No mount with id "${request.params.id}"`);
      }
      if (d.type !== 'smb' && d.type !== 'disk') {
        throw createAppError('MOUNT_INVALID', `Unknown mount type "${d.type}"`);
      }
      try {
        if (d.type === 'smb') {
          const { backupMountId } = await getSettings();
          await mountSMB(d.share, d.mountPath, {
            username: d.username, password: d.password, ownerOnly: d.id === backupMountId,
          });
        } else {
          await mountDisk(d.uuid, d.mountPath, { fsType: d.fsType, readOnly: d.readOnly });
          refreshDiskSnapshot();
        }
      } catch (err) {
        throw asAppError(err, `Failed to mount "${d.label || d.mountPath}"`);
      }
      return reply.code(204).send();
    },
  });

  // A job: an unmount flushes first, which after a large write takes a while.
  // Not found (404) and not mounted (409) are answered here.
  fastify.post('/host/mounts/:id/unmount', {
    config: { auth: 'admin' },
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      response: JOB_ACCEPTED,
    },
    handler: async (request, reply) => {
      const mounts = await getRawMounts();
      const d = mounts.find((x) => x.id === request.params.id);
      if (!d) {
        throw createAppError('MOUNT_NOT_FOUND', `No mount with id "${request.params.id}"`);
      }
      if (!(await getMountStatus(d.mountPath)).mounted) {
        throw createAppError('MOUNT_NOT_MOUNTED', `"${d.label || d.mountPath}" is not mounted`);
      }
      const job = await startJob({
        kind: BACKGROUND_JOB_KIND.MOUNT_UNMOUNT,
        title: titleForUnmount(d.label || d.mountPath),
        log: request.log,
        run: async () => {
          if (d.type === 'disk') {
            await unmountDisk(d.mountPath);
            refreshDiskSnapshot();
          } else {
            await unmountSMB(d.mountPath);
          }
          return { id: d.id };
        },
      });
      return reply.code(202).send(job);
    },
  });
}
