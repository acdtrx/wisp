import { randomBytes } from 'node:crypto';

import {
  listVMs,
  getVMConfig,
  getVMXML,
  updateVMConfig,
  assertVMNameAvailable,
  createVM,
  assertVMState,
  startVM,
  stopVM,
  forceStopVM,
  rebootVM,
  suspendVM,
  resumeVM,
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
  createBackup,
  isOfflineState,
} from '../lib/vmManager/index.js';
import {
  createJobStore,
  backupJobStore,
  operationJobStore,
  BACKGROUND_JOB_KIND,
  titleForVmCreate,
  titleForBackup,
  titleForVmStart,
  titleForVmForceStop,
  titleForVmDelete,
} from '../lib/jobs/index.js';
import { publishVm, unpublishVm } from '../lib/vmMdnsReconciler.js';
import { generateCloudInit } from '../lib/cloudInit.js';
import { getSettings, getRawMounts } from '../lib/settings.js';
import { resolveBackupDestinations, backupToEachDestination } from '../lib/backupDestinations.js';
import { recordBackupAttempt } from '../lib/backupStatus.js';
import { acquireVmOperationLock, withVmOperationLock } from '../lib/vmOperationLock.js';
import { onSSEClose, setupSSE } from '../lib/sse.js';
import { resolveLibraryPath, assertPathInsideAllowedRoots } from '../lib/paths.js';
import { createAppError, errorBody, isExpectedAppError } from '../lib/appErrors.js';
import { validateVMName } from '../lib/validation.js';

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
        202: {
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
      // Name must be free in libvirt and on disk before any artifact is built:
      // cloud-init would otherwise write into an existing VM's directory.
      await assertVMNameAvailable(spec.name);
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
      const wantsCloudInit = !!(
        spec.cloudInit
        && spec.osType !== 'Windows'
        && spec.cloudInit.enabled !== false
      );
      (async () => {
        try {
          // The cloud-init seed ISO + cloud-init.json are built into the VM
          // directory createVM has just created, so they share its rollback:
          // any create failure removes the directory and everything in it.
          const result = await createVM(spec, {
            onStep(step, data) {
              createJobStore.pushEvent(jobId, { step, ...data });
            },
            populateVMDir: wantsCloudInit
              ? async () => {
                createJobStore.pushEvent(jobId, { step: 'cloudinit' });
                await generateCloudInit(vmName, spec.cloudInit);
              }
              : undefined,
          });
          createJobStore.completeJob(jobId, result);
        } catch (err) {
          if (!isExpectedAppError(err)) request.log.error({ err, jobId }, 'Background create-VM job failed');
          try {
            createJobStore.failJob(jobId, err);
          } catch (failErr) {
            request.log.error({ err: failErr, jobId }, 'failJob failed');
          }
        }
      })();
      return reply.code(202).send({ jobId, title });
    },
  });

  // GET /vms/create-progress/:jobId — SSE stream for create progress
  fastify.get('/vms/create-progress/:jobId', {
    config: { auth: 'read' },
    schema: { hide: true },
    handler: async (request, reply) => {
      const { jobId } = request.params;
      const job = createJobStore.getJob(jobId);
      if (!job) {
        throw createAppError('JOB_NOT_FOUND', `No job with id "${jobId}": it never started, or ended more than 5 minutes ago`);
      }
      setupSSE(reply);
      const ok = createJobStore.registerStream(jobId, reply.raw);
      if (!ok) {
        reply.raw.end();
        return;
      }
      onSSEClose(reply, () => {
        createJobStore.unregisterStream(jobId, reply.raw);
      });
    },
  });

  // POST /vms/:name/backup — start backup job; returns jobId; progress via GET /vms/backup-progress/:jobId
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
        202: {
          type: 'object',
          properties: {
            jobId: { type: 'string' },
            title: { type: 'string' },
          },
        },
      },
    },
    handler: async (request, reply) => {
      const { name } = request.params;
      const body = request.body || {};

      /* Fail fast in the request (the manager re-checks inside the job). */
      const vm = (await listVMs()).find((v) => v.name === name);
      if (!vm) throw createAppError('VM_NOT_FOUND', `VM "${name}" not found`);
      if (!isOfflineState(vm.stateCode)) {
        throw createAppError('VM_MUST_BE_OFFLINE', `VM "${name}" must be stopped to create a backup`);
      }

      const settings = await getSettings();
      const rawMounts = await getRawMounts();
      const destinations = await resolveBackupDestinations(settings, rawMounts, body.destinationIds);
      // Acquired with no await before createJob, so the lock and the job
      // appear together; released when the job settles.
      const releaseLock = acquireVmOperationLock(name, 'backup');
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
      const destinationIds = destinations.map((d) => d.id);
      backupToEachDestination(destinations, {
        push: (ev) => backupJobStore.pushEvent(jobId, ev),
        backupOne: (dest, onProgress) => createBackup(name, dest.path, { onProgress }),
      }).then(
        async (lastResult) => {
          // Free the VM before announcing completion, so an action the
          // client takes on `done` never meets a stale VM_BUSY.
          releaseLock();
          backupJobStore.completeJob(jobId, lastResult);
          await recordBackupAttempt({
            kind: 'vm', name, ok: true, origin: 'manual', destinationIds, timestamp: lastResult?.timestamp,
          });
        },
        async (err) => {
          releaseLock();
          backupJobStore.failJob(jobId, err);
          if (!isExpectedAppError(err)) request.log.error({ err, jobId }, 'Background backup job failed');
          await recordBackupAttempt({
            kind: 'vm', name, ok: false, origin: 'manual', destinationIds, error: err?.message,
          });
        },
      );
      return reply.code(202).send({ jobId, title });
    },
  });

  // GET /vms/backup-progress/:jobId — SSE stream for backup progress
  fastify.get('/vms/backup-progress/:jobId', {
    config: { auth: 'read' },
    schema: { hide: true },
    handler: async (request, reply) => {
      const { jobId } = request.params;
      const job = backupJobStore.getJob(jobId);
      if (!job) {
        throw createAppError('JOB_NOT_FOUND', `No job with id "${jobId}": it never started, or ended more than 5 minutes ago`);
      }
      setupSSE(reply);
      const ok = backupJobStore.registerStream(jobId, reply.raw);
      if (!ok) {
        reply.raw.end();
        return;
      }
      onSSEClose(reply, () => {
        backupJobStore.unregisterStream(jobId, reply.raw);
      });
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
    },
    // A job: undefining and deleting disk files can take a while. A missing VM
    // (404) or a busy one (409) is refused here; the outcome arrives over the
    // job's stream.
    handler: async (request, reply) => {
      const { name } = request.params;
      const deleteDisks = request.query.deleteDisks === 'true';
      const release = acquireVmOperationLock(name, 'delete');
      try {
        await assertVMState(name, 'exists');
      } catch (err) {
        release();
        throw err;
      }
      const job = operationJobStore.startOperationJob({
        kind: BACKGROUND_JOB_KIND.VM_DELETE,
        title: titleForVmDelete(name),
        log: request.log,
        run: async () => {
          try {
            await deleteVM(name, deleteDisks);
            return { name };
          } finally {
            release();
          }
        },
      });
      return reply.code(202).send(job);
    },
  });

  // Lifecycle actions — all POST /vms/:name/<action>
  // Only start takes the per-VM operation lock: the other actions apply to a
  // running VM and change no definition or disk file, while every locked
  // operation that holds the lock for long (backup) requires a stopped one.
  // Start and force-stop are jobs — starting a large VM, or waiting for QEMU
  // to exit, can outlast a short request: the POST answers 202 with the job
  // id, the outcome arrives over the job's stream. The others answer at once.
  const lifecycleJobs = [
    { path: 'start', kind: BACKGROUND_JOB_KIND.VM_START, title: titleForVmStart, lock: 'start', check: 'start', fn: startVM },
    { path: 'force-stop', kind: BACKGROUND_JOB_KIND.VM_FORCE_STOP, title: titleForVmForceStop, check: 'running', fn: forceStopVM },
  ];
  for (const { path, kind, title, lock, check, fn } of lifecycleJobs) {
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
        const { name } = request.params;
        const release = lock ? acquireVmOperationLock(name, lock) : () => {};
        try {
          await assertVMState(name, check); // not found, already running / not running: answered here
        } catch (err) {
          release();
          throw err;
        }
        const job = operationJobStore.startOperationJob({
          kind,
          title: title(name),
          log: request.log,
          run: async () => {
            try {
              await fn(name);
              return { name };
            } finally {
              release();
            }
          },
        });
        return reply.code(202).send(job);
      },
    });
  }

  const lifecycleActions = [
    { path: 'stop', fn: stopVM },
    { path: 'reboot', fn: rebootVM },
    { path: 'suspend', fn: suspendVM },
    { path: 'resume', fn: resumeVM },
  ];

  for (const { path, fn } of lifecycleActions) {
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
        await fn(request.params.name);
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
      // Every edit redefines the domain (a rename also moves the VM
      // directory), so none may run under a backup reading the definition
      // and disks. Rename reserves the target name inside the manager.
      const renaming = request.body.name !== undefined && request.body.name !== request.params.name;
      const result = await withVmOperationLock(
        request.params.name,
        renaming ? 'rename' : 'config edit',
        () => updateVMConfig(request.params.name, request.body),
      );
      // mDNS toggle/rename: vmManager doesn't fire DomainEvent for metadata-only
      // changes, so the publisher won't reconcile on its own. Nudge it here.
      if (request.body.localDns === false) {
        await unpublishVm(result.name).catch(() => { /* best effort */ });
      } else if (request.body.localDns === true) {
        await publishVm(result.name).catch(() => { /* best effort */ });
      }
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
        await withVmOperationLock(name, 'disk change', () => attachDisk(name, slot, absPath, bus));
      } else {
        await withVmOperationLock(name, 'disk change', () => createAndAttachDisk(name, slot, sizeGB, bus));
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
      await withVmOperationLock(name, 'disk change', () => detachDisk(name, slot));
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
      await withVmOperationLock(name, 'disk change', () => resizeDiskBySlot(name, slot, request.body.sizeGB));
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
      await withVmOperationLock(name, 'disk change', () => updateDiskBus(name, slot, request.body.bus));
      reply.code(204).send();
    },
  });

  // POST /vms/:name/cdrom/:slot — attach ISO
  // CD-ROM and USB changes take the lock in every VM state: a hot-plug on a
  // running VM writes the persistent definition too (LIVE + CONFIG), and the
  // one long holder (backup) needs a stopped VM, so a running VM never waits.
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
      await withVmOperationLock(name, 'CD-ROM change', () => attachISO(name, slot, absPath));
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
      await withVmOperationLock(name, 'CD-ROM change', () => ejectISO(name, slot));
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
      await withVmOperationLock(name, 'USB change', () => attachUSBDevice(name, vendorId, productId));
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
      await withVmOperationLock(name, 'USB change', () => detachUSBDevice(name, vendorId, productId));
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
          reply.raw.write(`data: ${JSON.stringify(errorBody(err))}\n\n`);
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
