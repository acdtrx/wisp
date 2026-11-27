import {
  listVMs,
  getVMDetail,
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
  attachVmIso,
  ejectVmIso,
  attachVmUsb,
  detachVmUsb,
} from '../lib/vmOperations.js';
import { onSSEClose, setupSSE, writeSSEError } from '../lib/sse.js';
import { resolveLibraryPath, assertPathInsideAllowedRoots } from '../lib/paths.js';
import { createAppError } from '../lib/appErrors.js';
import { vmNameSchema } from '../lib/validation.js';
import { PROFILE_NAMES } from '../lib/vmProfiles.js';
import {
  backupBodySchema, cloudInitSchema, jobAckSchema, noContentSchema, vmParamsSchema,
} from './schemas.js';

/** The values Wisp writes into `<video><model type>` and `<graphics type>` (API-VMS.md). */
const VIDEO_DRIVERS = ['virtio', 'qxl', 'vga'];
const GRAPHICS_TYPES = ['vnc', 'spice'];

/** A NIC of a create or an edit; `source` and `mac` are left out for the defaults. */
const nicSchema = {
  type: 'object',
  properties: {
    type: { type: 'string' },
    source: { type: 'string' },
    model: { type: 'string' },
    mac: { type: 'string' },
  },
  additionalProperties: false,
};

/** A create's disk: none, a new one of `sizeGB`, or a copy of `sourcePath`, grown to `resizeGB`. */
const createDiskSchema = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['none', 'new', 'existing'] },
    sizeGB: { type: 'integer' },
    bus: { type: 'string' },
    sourcePath: { type: 'string' },
    resizeGB: { type: 'number' },
  },
  additionalProperties: false,
};

const diskSlotParam = { slot: { type: 'string', minLength: 1 } };

const pendingRestartSchema = { type: ['object', 'null'], properties: { since: { type: 'string' } }, additionalProperties: false };

/** GET /vms rows, the `vms` topic's array too. */
const vmListItemSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    uuid: { type: 'string' },
    state: { type: 'string' },
    stateCode: { type: 'integer' },
    vcpus: { type: 'integer' },
    memoryMiB: { type: 'integer' },
    profile: { type: ['string', 'null'] },
    iconId: { type: ['string', 'null'] },
    guestAgent: { type: 'boolean' },
    pendingRestart: pendingRestartSchema,
    startedAt: { type: ['number', 'null'] },
    staleBinary: { type: 'boolean' },
  },
  additionalProperties: false,
};

/** GET /vms/:name: the VM's saved configuration (its inactive domain XML), its state and its guest's network. */
const vmDetailSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    uuid: { type: 'string' },
    state: { type: 'string' },
    stateCode: { type: 'integer' },
    autostart: { type: 'boolean' },
    vcpus: { type: 'integer' },
    memoryMiB: { type: 'integer' },
    osType: { type: 'string' },
    profile: { type: ['string', 'null'] },
    arch: { type: ['string', 'null'] },
    machineType: { type: ['string', 'null'] },
    firmware: { type: 'string' },
    cpuMode: { type: ['string', 'null'] },
    cpuTopology: {
      type: ['object', 'null'],
      properties: {
        sockets: { type: 'integer' },
        dies: { type: 'integer' },
        cores: { type: 'integer' },
        threads: { type: 'integer' },
      },
      additionalProperties: false,
    },
    cpuFeatures: {
      type: 'array',
      items: { type: 'object', properties: { name: { type: 'string' }, policy: { type: 'string' } }, additionalProperties: false },
    },
    nestedVirt: { type: 'boolean' },
    bootOrder: { type: 'array', items: { type: 'string' } },
    bootMenu: { type: 'boolean' },
    disks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          slot: { type: ['string', 'null'] },
          device: { type: 'string' },
          bus: { type: ['string', 'null'] },
          source: { type: ['string', 'null'] },
          driverType: { type: ['string', 'null'] },
          readonly: { type: 'boolean' },
          sizeGiB: { type: 'integer' },
        },
        additionalProperties: false,
      },
    },
    nics: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: ['string', 'null'] },
          mac: { type: ['string', 'null'] },
          source: { type: ['string', 'null'] },
          model: { type: ['string', 'null'] },
          target: { type: ['string', 'null'] },
        },
        additionalProperties: false,
      },
    },
    graphics: {
      type: ['object', 'null'],
      properties: {
        type: { type: ['string', 'null'] },
        port: { type: ['integer', 'null'] },
        listen: { type: ['string', 'null'] },
        autoport: { type: ['string', 'null'] },
      },
      additionalProperties: false,
    },
    videoModel: { type: ['string', 'null'] },
    features: { type: 'object', properties: { hyperv: { type: 'boolean' } }, additionalProperties: false },
    memBalloon: { type: 'boolean' },
    guestAgent: { type: 'boolean' },
    vtpm: { type: 'boolean' },
    virtioRng: { type: 'boolean' },
    iconId: { type: ['string', 'null'] },
    pendingRestart: pendingRestartSchema,
    startedAt: { type: ['number', 'null'] },
    guestNetwork: {
      type: 'object',
      properties: { ip: { type: ['string', 'null'] }, hostname: { type: ['string', 'null'] } },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

export default async function vmsRoutes(fastify) {
  // GET /vms — list all VMs
  fastify.get('/vms', {
    config: { auth: 'read' },
    schema: {
      response: {
        200: {
          type: 'array',
          items: vmListItemSchema,
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
        required: ['name', 'profile'],
        properties: {
          name: vmNameSchema,
          profile: { type: 'string', enum: PROFILE_NAMES },
          osType: { type: 'string' },
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
          vtpm: { type: 'boolean' },
          virtioRng: { type: 'boolean' },
          nestedVirt: { type: 'boolean' },
          nics: { type: 'array', items: nicSchema },
          disk: createDiskSchema,
          disk2: createDiskSchema,
          cdrom1Path: { type: 'string' },
          cdrom2Path: { type: 'string' },
          cloudInit: cloudInitSchema,
        },
        additionalProperties: false,
      },
      response: {
        202: jobAckSchema,
      },
    },
    handler: async (request, reply) => {
      const spec = request.body;
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
      params: vmParamsSchema(),
      body: backupBodySchema,
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

  // GET /vms/:name — the VM read, MCP's get_vm's body too
  fastify.get('/vms/:name', {
    config: { auth: 'read' },
    schema: {
      params: vmParamsSchema(),
      response: { 200: vmDetailSchema },
    },
    handler: async (request) => getVMDetail(request.params.name),
  });

  // DELETE /vms/:name — delete VM
  fastify.delete('/vms/:name', {
    config: { auth: 'admin' },
    schema: {
      params: vmParamsSchema(),
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
        params: vmParamsSchema(),
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
        params: vmParamsSchema(),
        response: { 204: noContentSchema },
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
      params: vmParamsSchema(),
      body: {
        type: 'object',
        properties: {
          name: vmNameSchema,
          memoryMiB: { type: 'integer', minimum: 128 },
          vcpus: { type: 'integer', minimum: 1 },
          cpuMode: { type: 'string' },
          nestedVirt: { type: 'boolean' },
          bootOrder: { type: 'array', items: { type: 'string' } },
          bootMenu: { type: 'boolean' },
          osType: { type: 'string' },
          nics: { type: 'array', items: nicSchema },
          videoDriver: { type: 'string', enum: VIDEO_DRIVERS },
          graphicsType: { type: 'string', enum: GRAPHICS_TYPES },
          memBalloon: { type: 'boolean' },
          guestAgent: { type: 'boolean' },
          vtpm: { type: 'boolean' },
          virtioRng: { type: 'boolean' },
          iconId: { type: ['string', 'null'] },
          autostart: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      response: { 204: noContentSchema },
    },
    handler: async (request, reply) => {
      await editVmConfig({ name: request.params.name, changes: request.body, log: request.log });
      reply.code(204).send();
    },
  });

  // GET /vms/:name/xml — raw domain XML
  fastify.get('/vms/:name/xml', {
    config: { auth: 'read' },
    schema: {
      params: vmParamsSchema(),
      response: { 200: { type: 'object', properties: { xml: { type: 'string' } }, additionalProperties: false } },
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
      params: vmParamsSchema(),
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
      response: { 204: noContentSchema },
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
      params: vmParamsSchema(diskSlotParam),
      response: { 204: noContentSchema },
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
      params: vmParamsSchema(diskSlotParam),
      body: {
        type: 'object',
        required: ['sizeGB'],
        properties: {
          sizeGB: { type: 'number', minimum: 1 },
        },
        additionalProperties: false,
      },
      response: { 204: noContentSchema },
    },
    handler: async (request, reply) => {
      const { name, slot } = request.params;
      await resizeVmDisk(name, slot, request.body.sizeGB);
      reply.code(204).send();
    },
  });

  // POST /vms/:name/cdrom/:slot — attach ISO
  fastify.post('/vms/:name/cdrom/:slot', {
    config: { auth: 'admin' },
    schema: {
      params: vmParamsSchema(diskSlotParam),
      body: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string' },
        },
        additionalProperties: false,
      },
      response: { 204: noContentSchema },
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
      params: vmParamsSchema(diskSlotParam),
      response: { 204: noContentSchema },
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
      params: vmParamsSchema(),
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              vendorId: { type: 'string' },
              productId: { type: 'string' },
            },
            additionalProperties: false,
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
      params: vmParamsSchema(),
      body: {
        type: 'object',
        required: ['vendorId', 'productId'],
        properties: {
          vendorId: { type: 'string', pattern: '^[0-9a-fA-F]{4}$' },
          productId: { type: 'string', pattern: '^[0-9a-fA-F]{4}$' },
        },
        additionalProperties: false,
      },
      response: { 204: noContentSchema },
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
      params: vmParamsSchema({ id: { type: 'string', pattern: '^[0-9a-fA-F]{4}:[0-9a-fA-F]{4}$' } }),
      response: { 204: noContentSchema },
    },
    handler: async (request, reply) => {
      const [vendorId, productId] = request.params.id.split(':');
      const { name } = request.params;
      await detachVmUsb(name, vendorId, productId);
      reply.code(204).send();
    },
  });

  // GET /vms/:name/stats — SSE endpoint
  fastify.get('/vms/:name/stats', {
    config: { auth: 'read', answers: 'sse' },
    schema: { params: vmParamsSchema() },
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
