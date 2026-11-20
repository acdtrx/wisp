import {
  listVMs,
  getVMConfig,
  getVMXML,
  getVMStats,
  getVMUSBDevices,
} from '../lib/vmManager/index.js';
import {
  startVmCreateJob,
  startVmBackupJob,
  startVmStartJob,
  startVmForceStopJob,
  startVmDeleteJob,
  requestVmStop,
  requestVmReboot,
  requestVmSuspend,
  requestVmResume,
  editVmConfig,
  attachVmDisk,
  createVmDisk,
  detachVmDisk,
  resizeVmDisk,
  changeVmDiskBus,
  attachVmIso,
  ejectVmIso,
  attachVmUsb,
  detachVmUsb,
} from '../lib/vmOperations.js';
import { onSSEClose, setupSSE, writeSSEError } from '../lib/sse.js';
import { resolveLibraryPath, assertPathInsideAllowedRoots } from '../lib/paths.js';
import { createAppError } from '../lib/appErrors.js';
import { validateVMName } from '../lib/validation.js';
import { jobAckSchema } from './schemas.js';

/** The values Wisp writes into `<video><model type>` and `<graphics type>` (API-VMS.md). */
const VIDEO_DRIVERS = ['virtio', 'qxl', 'vga'];
const GRAPHICS_TYPES = ['vnc', 'spice'];

export default async function vmsRoutes(fastify) {
  fastify.addHook('preHandler', async (request) => {
    const name = request.params?.name;
    if (name !== undefined) validateVMName(name);
  });

  // GET /vms — list all VMs
  fastify.get('/vms', {
    config: { auth: 'read' },
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
              pendingRestart: {
                type: ['object', 'null'],
                properties: { since: { type: 'string' } },
              },
            },
          },
        },
      },
    },
    handler: async () => listVMs(),
  });

  // POST /vms — create VM (async job, returns jobId)
  fastify.post('/vms', {
    config: { auth: 'admin' },
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
          videoDriver: { type: 'string', enum: VIDEO_DRIVERS },
          graphicsType: { type: 'string', enum: GRAPHICS_TYPES },
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
        202: jobAckSchema,
      },
    },
    handler: async (request, reply) => {
      const spec = request.body;
      validateVMName(spec?.name);
      /* Resolve library-relative paths to absolute and run the security check
         here, in Wisp glue, before vmManager touches them. vmManager itself
         is policy-agnostic about which host paths are "allowed". */
      if (spec.cdrom1Path) {
        spec.cdrom1Path = resolveLibraryPath(spec.cdrom1Path);
        await assertPathInsideAllowedRoots(spec.cdrom1Path, spec.name);
      }
      if (spec.cdrom2Path) {
        spec.cdrom2Path = resolveLibraryPath(spec.cdrom2Path);
        await assertPathInsideAllowedRoots(spec.cdrom2Path, spec.name);
      }
      for (const dspec of [spec.disk, spec.disk2]) {
        if (dspec && dspec.type === 'existing' && dspec.sourcePath) {
          dspec.sourcePath = resolveLibraryPath(dspec.sourcePath);
          await assertPathInsideAllowedRoots(dspec.sourcePath, spec.name);
        }
      }
      const job = await startVmCreateJob({ spec, log: request.log });
      return reply.code(202).send(job);
    },
  });

  // POST /vms/:name/backup — a backup job; progress on GET /jobs/:jobId/progress
  fastify.post('/vms/:name/backup', {
    config: { auth: 'admin' },
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
        202: jobAckSchema,
      },
    },
    handler: async (request, reply) => {
      const job = await startVmBackupJob({
        name: request.params.name, destinationIds: request.body?.destinationIds, log: request.log,
      });
      return reply.code(202).send(job);
    },
  });

  // GET /vms/:name — full VM config
  fastify.get('/vms/:name', {
    config: { auth: 'read' },
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
    },
    handler: async (request) => {
      return await getVMConfig(request.params.name);
    },
  });

  // DELETE /vms/:name — delete VM
  fastify.delete('/vms/:name', {
    config: { auth: 'admin' },
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
      response: { 202: jobAckSchema },
    },
    // A job: undefining and deleting disk files can take a while. A missing VM
    // (404) or a busy one (409) is refused here; the outcome arrives over the
    // job's stream.
    handler: async (request, reply) => {
      const job = await startVmDeleteJob({
        name: request.params.name, deleteDisks: request.query.deleteDisks === 'true', log: request.log,
      });
      return reply.code(202).send(job);
    },
  });

  // Lifecycle actions — all POST /vms/:name/<action>. Start and force-stop are
  // jobs — starting a large VM, or waiting for QEMU to exit, can outlast a
  // short request: the POST answers 202 with the job's ack. Stop, reboot,
  // suspend and resume answer at once.
  const lifecycleJobs = [
    { path: 'start', start: startVmStartJob },
    { path: 'force-stop', start: startVmForceStopJob },
  ];
  for (const { path, start } of lifecycleJobs) {
    fastify.post(`/vms/:name/${path}`, {
      config: { auth: 'admin' },
      schema: {
        params: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
        },
        response: { 202: jobAckSchema },
      },
      handler: async (request, reply) => {
        const job = await start({ name: request.params.name, log: request.log });
        return reply.code(202).send(job);
      },
    });
  }

  const lifecycleActions = [
    { path: 'stop', request: requestVmStop },
    { path: 'reboot', request: requestVmReboot },
    { path: 'suspend', request: requestVmSuspend },
    { path: 'resume', request: requestVmResume },
  ];

  for (const { path, request: send } of lifecycleActions) {
    fastify.post(`/vms/:name/${path}`, {
      config: { auth: 'admin' },
      schema: {
        params: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
        },
      },
      handler: async (request, reply) => {
        await send(request.params.name);
        reply.code(204).send();
      },
    });
  }

  // PATCH /vms/:name — update VM config
  fastify.patch('/vms/:name', {
    config: { auth: 'admin' },
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
              },
              additionalProperties: false,
            },
          },
          videoDriver: { type: 'string', enum: VIDEO_DRIVERS },
          graphicsType: { type: 'string', enum: GRAPHICS_TYPES },
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
      if (request.body.name !== undefined) validateVMName(request.body.name);
      await editVmConfig({ name: request.params.name, changes: request.body, log: request.log });
      reply.code(204).send();
    },
  });

  // GET /vms/:name/xml — raw domain XML
  fastify.get('/vms/:name/xml', {
    config: { auth: 'read' },
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
    },
    handler: async (request) => {
      const xml = await getVMXML(request.params.name);
      return { xml };
    },
  });

  // POST /vms/:name/disks — attach existing disk (path) or create and attach new disk (sizeGB)
  fastify.post('/vms/:name/disks', {
    config: { auth: 'admin' },
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
      const { slot, path, sizeGB, bus } = request.body;
      const hasPath = path != null && path !== '';
      const hasSize = sizeGB != null && sizeGB > 0;
      if (hasPath && hasSize) {
        throw createAppError('INVALID_REQUEST', 'Provide either path (attach existing) or sizeGB (create new), not both');
      }
      if (!hasPath && !hasSize) {
        throw createAppError('INVALID_REQUEST', 'Provide path (attach existing) or sizeGB (create new)');
      }
      const { name } = request.params;
      if (hasPath) {
        const absPath = resolveLibraryPath(path);
        await assertPathInsideAllowedRoots(absPath, name);
        await attachVmDisk(name, slot, absPath, bus);
      } else {
        await createVmDisk(name, slot, sizeGB, bus);
      }
      reply.code(204).send();
    },
  });

  // DELETE /vms/:name/disks/:slot — detach disk
  fastify.delete('/vms/:name/disks/:slot', {
    config: { auth: 'admin' },
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
      const { name, slot } = request.params;
      await detachVmDisk(name, slot);
      reply.code(204).send();
    },
  });

  // POST /vms/:name/disks/:slot/resize — resize disk
  fastify.post('/vms/:name/disks/:slot/resize', {
    config: { auth: 'admin' },
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
      const { name, slot } = request.params;
      await resizeVmDisk(name, slot, request.body.sizeGB);
      reply.code(204).send();
    },
  });

  // POST /vms/:name/disks/:slot/bus — change block disk target bus (VM stopped)
  fastify.post('/vms/:name/disks/:slot/bus', {
    config: { auth: 'admin' },
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
      const { name, slot } = request.params;
      await changeVmDiskBus(name, slot, request.body.bus);
      reply.code(204).send();
    },
  });

  // POST /vms/:name/cdrom/:slot — attach ISO
  fastify.post('/vms/:name/cdrom/:slot', {
    config: { auth: 'admin' },
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
      const { name, slot } = request.params;
      const absPath = resolveLibraryPath(request.body.path);
      await assertPathInsideAllowedRoots(absPath, name);
      await attachVmIso(name, slot, absPath);
      reply.code(204).send();
    },
  });

  // DELETE /vms/:name/cdrom/:slot — eject ISO
  fastify.delete('/vms/:name/cdrom/:slot', {
    config: { auth: 'admin' },
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
      const { name, slot } = request.params;
      await ejectVmIso(name, slot);
      reply.code(204).send();
    },
  });

  // GET /vms/:name/usb — USB devices attached to this VM
  fastify.get('/vms/:name/usb', {
    config: { auth: 'read' },
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
    handler: async (request) => {
      return await getVMUSBDevices(request.params.name);
    },
  });

  // POST /vms/:name/usb — attach USB device
  fastify.post('/vms/:name/usb', {
    config: { auth: 'admin' },
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
      const { name } = request.params;
      const { vendorId, productId } = request.body;
      await attachVmUsb(name, vendorId, productId);
      reply.code(204).send();
    },
  });

  // DELETE /vms/:name/usb/:id — detach USB device (id = vendorId:productId)
  fastify.delete('/vms/:name/usb/:id', {
    config: { auth: 'admin' },
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
      const [vendorId, productId] = request.params.id.split(':');
      if (!vendorId || !productId) {
        throw createAppError('INVALID_USB_ID', 'Invalid USB device ID format, expected vendorId:productId');
      }
      if (!/^[0-9a-fA-F]{4}$/.test(vendorId) || !/^[0-9a-fA-F]{4}$/.test(productId)) {
        throw createAppError('INVALID_USB_ID', 'Invalid USB device ID format');
      }
      const { name } = request.params;
      await detachVmUsb(name, vendorId, productId);
      reply.code(204).send();
    },
  });

  // GET /vms/:name/stats — SSE endpoint
  fastify.get('/vms/:name/stats', {
    config: { auth: 'read' },
    schema: { hide: true },
    handler: async (request, reply) => {
      const { name } = request.params;

      setupSSE(reply);

      async function sendStats() {
        try {
          const stats = await getVMStats(name);
          reply.raw.write(`data: ${JSON.stringify(stats)}\n\n`);
        } catch (err) {
          writeSSEError(reply.raw, err);
        }
      }

      await sendStats();
      const interval = setInterval(sendStats, 5000);

      onSSEClose(reply, () => {
        clearInterval(interval);
      });
    },
  });
}
