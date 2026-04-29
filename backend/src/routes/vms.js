import { randomBytes } from 'node:crypto';

import {
  listVMs,
  getVMConfig,
  getVMXML,
  updateVMConfig,
  createVM,
  startVM,
  stopVM,
  forceStopVM,
  rebootVM,
  suspendVM,
  resumeVM,
  cloneVM,
  deleteVM,
  getVMStats,
  attachDisk,
  createAndAttachDisk,
  detachDisk,
  resizeDiskBySlot,
  updateDiskBus,
  attachISO,
  ejectISO,
  getVMUSBDevices,
  attachUSBDevice,
  detachUSBDevice,
  listSnapshots,
  createSnapshot,
  revertSnapshot,
  deleteSnapshot,
  createBackup,
  subscribeVMListChange,
} from '../lib/vmManager.js';
import * as createJobStore from '../lib/createJobStore.js';
import * as backupJobStore from '../lib/backupJobStore.js';
import { getSettings, getRawMounts } from '../lib/settings.js';
import { getMountStatus, mountSMB } from '../lib/smbMount.js';
import { setupSSE } from '../lib/sse.js';
import { createAppError, handleRouteError } from '../lib/routeErrors.js';
import { validateVMName } from '../lib/validation.js';
import { BACKGROUND_JOB_KIND } from '../lib/backgroundJobKinds.js';
import { titleForVmCreate, titleForBackup } from '../lib/backgroundJobTitles.js';

export default async function vmsRoutes(fastify) {
  fastify.addHook('preHandler', async (request, reply) => {
    const name = request.params?.name;
    if (name !== undefined) {
      try {
        validateVMName(name);
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    }
  });

  // GET /vms — list all VMs
  fastify.get('/vms', {
    schema: {
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              uuid: { type: 'string' },
              state: { type: 'string' },
              stateCode: { type: 'integer' },
              vcpus: { type: 'integer' },
              memoryMiB: { type: 'integer' },
              osCategory: { type: 'string' },
              autostart: { type: 'boolean' },
              iconId: { type: ['string', 'null'] },
              localDns: { type: 'boolean' },
            },
          },
        },
      },
    },
    handler: async (_request, reply) => {
      try {
        return await listVMs();
      } catch (err) {
        handleRouteError(err, reply, _request);
      }
    },
  });

  // GET /vms/stream — SSE endpoint for VM list updates. Pushes on libvirt
  // domain events and qemu binary changes; no polling timer.
  fastify.get('/vms/stream', {
    schema: { hide: true },
    handler: async (request, reply) => {
      setupSSE(reply);

      async function sendList() {
        try {
          const vms = await listVMs();
          reply.raw.write(`data: ${JSON.stringify(vms)}\n\n`);
        } catch (err) {
          request.log.warn({ err: err.message }, 'vms/stream listVMs failed');
          const payload = { error: err.message, detail: err.raw || err.message, code: err.code };
          reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
      }

      await sendList();
      const unsubscribe = subscribeVMListChange(() => { sendList(); });

      request.raw.on('close', () => {
        unsubscribe();
      });
    },
  });

  // POST /vms — create VM (async job, returns jobId)
  fastify.post('/vms', {
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 128 },
          template: { type: 'string' },
          osType: { type: 'string' },
          osVariant: { type: 'string' },
          vcpus: { type: 'integer', minimum: 1 },
          memoryMiB: { type: 'integer', minimum: 128 },
          autostart: { type: 'boolean' },
          firmware: { type: 'string' },
          machineType: { type: 'string' },
          cpuMode: { type: 'string' },
          videoDriver: { type: 'string' },
          graphicsType: { type: 'string' },
          bootOrder: { type: 'array', items: { type: 'string' } },
          bootMenu: { type: 'boolean' },
          memBalloon: { type: 'boolean' },
          guestAgent: { type: 'boolean' },
          localDns: { type: 'boolean' },
          vtpm: { type: 'boolean' },
          virtioRng: { type: 'boolean' },
          nestedVirt: { type: 'boolean' },
          nics: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string' },
                source: { type: 'string' },
                model: { type: 'string' },
                mac: { type: 'string' },
                vlan: { type: 'integer' },
              },
            },
          },
          disk: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['none', 'new', 'existing'] },
              sizeGB: { type: 'integer' },
              bus: { type: 'string' },
              sourcePath: { type: 'string' },
              resizeGB: { type: 'number' },
            },
          },
          disk2: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['none', 'new', 'existing'] },
              sizeGB: { type: 'integer' },
              bus: { type: 'string' },
              sourcePath: { type: 'string' },
              resizeGB: { type: 'number' },
            },
          },
          cdrom1Path: { type: 'string' },
          cdrom2Path: { type: 'string' },
          cloudInit: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
              // RFC 1123 hostname label
              hostname: { type: 'string', maxLength: 63, pattern: '^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$' },
              username: { type: 'string', maxLength: 32, pattern: '^[a-z][a-z0-9_-]{0,31}$' },
              password: { type: 'string', maxLength: 256, pattern: '^[^\\r\\n]*$' },
              sshKey: { type: 'string', maxLength: 16384 },
              growPartition: { type: 'boolean' },
              packageUpgrade: { type: 'boolean' },
              installQemuGuestAgent: { type: 'boolean' },
              installAvahiDaemon: { type: 'boolean' },
            },
            additionalProperties: false,
          },
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
      const spec = request.body;
      try {
        validateVMName(spec?.name);
      } catch (err) {
        return handleRouteError(err, reply, request);
      }
      const jobId = randomBytes(12).toString('hex');
      const vmName = spec.name;
      const title = titleForVmCreate(vmName);
      createJobStore.createJob(jobId, {
        kind: BACKGROUND_JOB_KIND.VM_CREATE,
        title,
        log: request.log,
      });
      request.log.info(
        { jobId, kind: BACKGROUND_JOB_KIND.VM_CREATE, title },
        'Background job started',
      );
      (async () => {
        try {
          const result = await createVM(spec, {
            onStep(step, data) {
              createJobStore.pushEvent(jobId, { step, ...data });
            },
          });
          createJobStore.completeJob(jobId, result);
        } catch (err) {
          request.log.error({ err, jobId }, 'Background create-VM job failed');
          try {
            createJobStore.failJob(jobId, err);
          } catch (failErr) {
            request.log.error({ err: failErr, jobId }, 'failJob failed');
          }
        }
      })();
      return reply.code(201).send({ jobId, title });
    },
  });

  // GET /vms/create-progress/:jobId — SSE stream for create progress
  fastify.get('/vms/create-progress/:jobId', {
    schema: { hide: true },
    handler: async (request, reply) => {
      const { jobId } = request.params;
      const job = createJobStore.getJob(jobId);
      if (!job) {
        return reply.code(404).send({ error: 'Job not found', detail: jobId });
      }
      setupSSE(reply);
      const ok = createJobStore.registerStream(jobId, reply.raw);
      if (!ok) {
        reply.raw.end();
        return;
      }
      request.raw.on('close', () => {
        createJobStore.unregisterStream(jobId, reply.raw);
      });
    },
  });

  // POST /vms/:name/backup — start backup job; returns jobId; progress via GET /vms/backup-progress/:jobId
  fastify.post('/vms/:name/backup', {
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
      body: {
        type: 'object',
        properties: {
          destinationIds: { type: 'array', items: { type: 'string' } },
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
        const { name } = request.params;
        const body = request.body || {};
        const ids = body.destinationIds && body.destinationIds.length > 0 ? body.destinationIds : ['local'];
        const settings = await getSettings();
        const rawMounts = await getRawMounts();
        const backupMountId = settings.backupMountId;
        const paths = [];
        for (const id of ids) {
          if (id === 'local') {
            if (settings.backupLocalPath) paths.push(settings.backupLocalPath);
          } else if (backupMountId && id === backupMountId) {
            const dest = rawMounts.find((d) => d.id === id);
            if (!dest) {
              return reply.code(422).send({
                error: 'Invalid backup destination',
                detail: 'Mount is not configured for backup',
              });
            }
            const mountPath = dest.mountPath;
            if (dest.type === 'smb' && mountPath) {
              const { mounted } = await getMountStatus(mountPath);
              if (!mounted) {
                try {
                  await mountSMB(dest.share, mountPath, { username: dest.username, password: dest.password });
                } catch (mountErr) {
                  return reply.code(503).send({
                    error: 'Network mount failed',
                    detail: mountErr.message || 'Could not mount network share. Mount it from Host Mgmt first.',
                  });
                }
              }
              paths.push(mountPath);
            } else if (mountPath) {
              paths.push(mountPath);
            }
          } else {
            return reply.code(422).send({
              error: 'Invalid backup destination',
              detail: `Unknown or disallowed destination id: ${id}`,
            });
          }
        }
        if (paths.length === 0) {
          return reply.code(422).send({
            error: 'No backup destination',
            detail: 'No configured destination resolved for the requested ids',
          });
        }
        const jobId = randomBytes(12).toString('hex');
        const title = titleForBackup(name);
        backupJobStore.createJob(jobId, {
          kind: BACKGROUND_JOB_KIND.BACKUP,
          title,
          log: request.log,
        });
        request.log.info(
          { jobId, kind: BACKGROUND_JOB_KIND.BACKUP, title },
          'Background job started',
        );
        (async () => {
          let lastResult;
          for (const destPath of paths) {
            lastResult = await createBackup(name, destPath, {
              onProgress(ev) {
                backupJobStore.pushEvent(jobId, { step: ev.step, percent: ev.percent, currentFile: ev.currentFile });
              },
            });
          }
          backupJobStore.completeJob(jobId, lastResult);
        })().catch((err) => {
          backupJobStore.failJob(jobId, err);
          request.log.error({ err, jobId }, 'Background backup job failed');
        });
        return reply.code(201).send({ jobId, title });
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  // GET /vms/backup-progress/:jobId — SSE stream for backup progress
  fastify.get('/vms/backup-progress/:jobId', {
    schema: { hide: true },
    handler: async (request, reply) => {
      const { jobId } = request.params;
      const job = backupJobStore.getJob(jobId);
      if (!job) {
        return reply.code(404).send({ error: 'Job not found', detail: jobId });
      }
      setupSSE(reply);
      const ok = backupJobStore.registerStream(jobId, reply.raw);
      if (!ok) {
        reply.raw.end();
        return;
      }
      request.raw.on('close', () => {
        backupJobStore.unregisterStream(jobId, reply.raw);
      });
    },
  });

  // GET /vms/:name — full VM config
  fastify.get('/vms/:name', {
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
    },
    handler: async (request, reply) => {
      try {
        return await getVMConfig(request.params.name);
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  // DELETE /vms/:name — delete VM
  fastify.delete('/vms/:name', {
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
      querystring: {
        type: 'object',
        properties: {
          deleteDisks: { type: 'string', enum: ['true', 'false'] },
        },
        additionalProperties: false,
      },
    },
    handler: async (request, reply) => {
      try {
        await deleteVM(request.params.name, request.query.deleteDisks === 'true');
        return { ok: true };
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  // Lifecycle actions — all POST /vms/:name/<action>
  const lifecycleActions = [
    { path: 'start', fn: startVM },
    { path: 'stop', fn: stopVM },
    { path: 'force-stop', fn: forceStopVM },
    { path: 'reboot', fn: rebootVM },
    { path: 'suspend', fn: suspendVM },
    { path: 'resume', fn: resumeVM },
  ];

  for (const { path, fn } of lifecycleActions) {
    fastify.post(`/vms/:name/${path}`, {
      schema: {
        params: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
        },
      },
      handler: async (request, reply) => {
        try {
          await fn(request.params.name);
          return { ok: true };
        } catch (err) {
          request.log.warn({ err: err.message, code: err.code, detail: err.raw }, 'VM action failed');
          handleRouteError(err, reply, request);
        }
      },
    });
  }

  // POST /vms/:name/clone
  fastify.post('/vms/:name/clone', {
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['newName'],
        properties: {
          newName: { type: 'string', minLength: 1, maxLength: 128 },
        },
        additionalProperties: false,
      },
    },
    handler: async (request, reply) => {
      try {
        validateVMName(request.body.newName);
        await cloneVM(request.params.name, request.body.newName);
        return { ok: true };
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  // PATCH /vms/:name — update VM config
  fastify.patch('/vms/:name', {
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 128 },
          memoryMiB: { type: 'integer', minimum: 128 },
          vcpus: { type: 'integer', minimum: 1 },
          cpuMode: { type: 'string' },
          nestedVirt: { type: 'boolean' },
          machineType: { type: 'string' },
          firmware: { type: 'string' },
          bootOrder: { type: 'array', items: { type: 'string' } },
          bootMenu: { type: 'boolean' },
          osType: { type: 'string' },
          nics: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string' },
                source: { type: 'string' },
                model: { type: 'string' },
                mac: { type: 'string' },
                vlan: { type: 'integer' },
              },
              additionalProperties: false,
            },
          },
          videoDriver: { type: 'string' },
          graphicsType: { type: 'string' },
          memBalloon: { type: 'boolean' },
          guestAgent: { type: 'boolean' },
          vtpm: { type: 'boolean' },
          virtioRng: { type: 'boolean' },
          iconId: { type: ['string', 'null'] },
          localDns: { type: 'boolean' },
          autostart: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
    handler: async (request, reply) => {
      try {
        return await updateVMConfig(request.params.name, request.body);
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  // GET /vms/:name/xml — raw domain XML
  fastify.get('/vms/:name/xml', {
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
    },
    handler: async (request, reply) => {
      try {
        const xml = await getVMXML(request.params.name);
        return { xml };
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  // POST /vms/:name/disks — attach existing disk (path) or create and attach new disk (sizeGB)
  fastify.post('/vms/:name/disks', {
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['slot'],
        properties: {
          slot: { type: 'string' },
          path: { type: 'string' },
          sizeGB: { type: 'number' },
          bus: { type: 'string', enum: ['virtio', 'scsi', 'sata', 'ide'], default: 'virtio' },
        },
        additionalProperties: false,
      },
    },
    handler: async (request, reply) => {
      try {
        const { slot, path, sizeGB, bus } = request.body;
        const hasPath = path != null && path !== '';
        const hasSize = sizeGB != null && sizeGB > 0;
        if (hasPath && hasSize) {
          return reply.code(422).send({ error: 'Invalid request', detail: 'Provide either path (attach existing) or sizeGB (create new), not both' });
        }
        if (!hasPath && !hasSize) {
          return reply.code(422).send({ error: 'Invalid request', detail: 'Provide path (attach existing) or sizeGB (create new)' });
        }
        if (hasPath) {
          await attachDisk(request.params.name, slot, path, bus);
        } else {
          await createAndAttachDisk(request.params.name, slot, sizeGB, bus);
        }
        return { ok: true };
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  // DELETE /vms/:name/disks/:slot — detach disk
  fastify.delete('/vms/:name/disks/:slot', {
    schema: {
      params: {
        type: 'object',
        required: ['name', 'slot'],
        properties: {
          name: { type: 'string' },
          slot: { type: 'string' },
        },
      },
    },
    handler: async (request, reply) => {
      try {
        await detachDisk(request.params.name, request.params.slot);
        return { ok: true };
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  // POST /vms/:name/disks/:slot/resize — resize disk
  fastify.post('/vms/:name/disks/:slot/resize', {
    schema: {
      params: {
        type: 'object',
        required: ['name', 'slot'],
        properties: {
          name: { type: 'string' },
          slot: { type: 'string' },
        },
      },
      body: {
        type: 'object',
        required: ['sizeGB'],
        properties: {
          sizeGB: { type: 'number', minimum: 1 },
        },
        additionalProperties: false,
      },
    },
    handler: async (request, reply) => {
      try {
        await resizeDiskBySlot(request.params.name, request.params.slot, request.body.sizeGB);
        return { ok: true };
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  // POST /vms/:name/disks/:slot/bus — change block disk target bus (VM stopped)
  fastify.post('/vms/:name/disks/:slot/bus', {
    schema: {
      params: {
        type: 'object',
        required: ['name', 'slot'],
        properties: {
          name: { type: 'string' },
          slot: { type: 'string' },
        },
      },
      body: {
        type: 'object',
        required: ['bus'],
        properties: {
          bus: { type: 'string', enum: ['virtio', 'scsi', 'sata', 'ide'] },
        },
        additionalProperties: false,
      },
    },
    handler: async (request, reply) => {
      try {
        await updateDiskBus(request.params.name, request.params.slot, request.body.bus);
        return { ok: true };
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  // POST /vms/:name/cdrom/:slot — attach ISO
  fastify.post('/vms/:name/cdrom/:slot', {
    schema: {
      params: {
        type: 'object',
        required: ['name', 'slot'],
        properties: {
          name: { type: 'string' },
          slot: { type: 'string' },
        },
      },
      body: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
    handler: async (request, reply) => {
      try {
        await attachISO(request.params.name, request.params.slot, request.body.path);
        return { ok: true };
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  // DELETE /vms/:name/cdrom/:slot — eject ISO
  fastify.delete('/vms/:name/cdrom/:slot', {
    schema: {
      params: {
        type: 'object',
        required: ['name', 'slot'],
        properties: {
          name: { type: 'string' },
          slot: { type: 'string' },
        },
      },
    },
    handler: async (request, reply) => {
      try {
        await ejectISO(request.params.name, request.params.slot);
        return { ok: true };
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  // GET /vms/:name/usb — USB devices attached to this VM
  fastify.get('/vms/:name/usb', {
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              vendorId: { type: 'string' },
              productId: { type: 'string' },
            },
          },
        },
      },
    },
    handler: async (request, reply) => {
      try {
        return await getVMUSBDevices(request.params.name);
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  // POST /vms/:name/usb — attach USB device
  fastify.post('/vms/:name/usb', {
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['vendorId', 'productId'],
        properties: {
          vendorId: { type: 'string', pattern: '^[0-9a-fA-F]{4}$' },
          productId: { type: 'string', pattern: '^[0-9a-fA-F]{4}$' },
        },
        additionalProperties: false,
      },
    },
    handler: async (request, reply) => {
      try {
        await attachUSBDevice(request.params.name, request.body.vendorId, request.body.productId);
        return { ok: true };
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  // DELETE /vms/:name/usb/:id — detach USB device (id = vendorId:productId)
  fastify.delete('/vms/:name/usb/:id', {
    schema: {
      params: {
        type: 'object',
        required: ['name', 'id'],
        properties: {
          name: { type: 'string' },
          id: { type: 'string' },
        },
      },
    },
    handler: async (request, reply) => {
      try {
        const [vendorId, productId] = request.params.id.split(':');
        if (!vendorId || !productId) {
          throw createAppError('INVALID_USB_ID', 'Invalid USB device ID format, expected vendorId:productId');
        }
        if (!/^[0-9a-fA-F]{4}$/.test(vendorId) || !/^[0-9a-fA-F]{4}$/.test(productId)) {
          throw createAppError('INVALID_USB_ID', 'Invalid USB device ID format');
        }
        await detachUSBDevice(request.params.name, vendorId, productId);
        return { ok: true };
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  // GET /vms/:name/snapshots
  fastify.get('/vms/:name/snapshots', {
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              creationTime: { type: 'number' },
              state: { type: 'string' },
            },
          },
        },
      },
    },
    handler: async (request, reply) => {
      try {
        return await listSnapshots(request.params.name);
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  // POST /vms/:name/snapshots
  fastify.post('/vms/:name/snapshots', {
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-zA-Z0-9 ._-]+$' },
        },
      },
      response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } } } },
    },
    handler: async (request, reply) => {
      try {
        await createSnapshot(request.params.name, request.body.name);
        return { ok: true };
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  // DELETE /vms/:name/snapshots/:id
  fastify.delete('/vms/:name/snapshots/:id', {
    schema: {
      params: {
        type: 'object',
        required: ['name', 'id'],
        properties: { name: { type: 'string' }, id: { type: 'string' } },
      },
      response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } } } },
    },
    handler: async (request, reply) => {
      try {
        await deleteSnapshot(request.params.name, request.params.id);
        return { ok: true };
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  // POST /vms/:name/snapshots/:id/revert
  fastify.post('/vms/:name/snapshots/:id/revert', {
    schema: {
      params: {
        type: 'object',
        required: ['name', 'id'],
        properties: { name: { type: 'string' }, id: { type: 'string' } },
      },
      response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } } } },
    },
    handler: async (request, reply) => {
      try {
        await revertSnapshot(request.params.name, request.params.id);
        return { ok: true };
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  // GET /vms/:name/stats — SSE endpoint
  fastify.get('/vms/:name/stats', {
    schema: { hide: true },
    handler: async (request, reply) => {
      const { name } = request.params;

      setupSSE(reply);

      async function sendStats() {
        try {
          const stats = await getVMStats(name);
          reply.raw.write(`data: ${JSON.stringify(stats)}\n\n`);
        } catch (err) {
          const payload = { error: err.message, detail: err.raw || err.message, code: err.code };
          reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
      }

      await sendStats();
      const interval = setInterval(sendStats, 3000);

      request.raw.on('close', () => {
        clearInterval(interval);
      });
    },
  });
}
