import { readFileSync } from 'node:fs';

import {
  getHostInfo,
  listHostFirmware,
} from '../lib/vmManager/index.js';
import {
  listHostBridges,
  listManagedNetworkBridges,
  listEligibleParentBridges,
  planManagedNetworkBridgeCreate,
  createManagedNetworkBridge,
  planManagedNetworkBridgeDelete,
  deleteManagedNetworkBridge,
} from '../lib/networking/index.js';
import {
  checkForUpdates,
  performUpgrade,
  isUpdateOperationInProgress,
  isUpgradeInProgress,
  listUpgradablePackages,
  getHostHardwareInfo,
  hostShutdown,
  hostReboot,
  listHostGpus,
  getDevices as getHostUSBDevicesCached,
  onChange as onHostUSBChange,
  getProfilerSoftwareOverview,
} from '../lib/host/index.js';
import { assertBridgeNotInUse } from '../lib/networkBridgeUsage.js';
import { asAppError, createAppError } from '../lib/appErrors.js';
import { onSSEClose, setupSSE, writeSSEError } from '../lib/sse.js';
import { getDevices as getHostDisksCached, onChange as onHostDiskChange } from '../lib/storage/index.js';
import { getCurrentVersion } from '../lib/wispUpdate.js';
import {
  operationJobStore,
  BACKGROUND_JOB_KIND,
  TITLE_OS_UPDATE_CHECK,
  TITLE_OS_UPGRADE,
  titleForBridgeCreate,
  titleForBridgeDelete,
} from '../lib/jobs/index.js';

const JOB_ACCEPTED = {
  202: { type: 'object', properties: { jobId: { type: 'string' }, title: { type: 'string' } } },
};

/** An upgrade runs, or its job was started and has not reached it yet. */
function upgradeRunning() {
  return isUpgradeInProgress() || operationJobStore.findRunningJob(BACKGROUND_JOB_KIND.OS_UPGRADE, TITLE_OS_UPGRADE) != null;
}

/**
 * The OS update check as a job: one shared run — a check or package refresh
 * started while one runs joins it (the same job id). Its `done` payload is the
 * count; the packages are then served from the cache (GET /host/updates/packages).
 * Refused with UPDATE_BUSY while an upgrade runs.
 */
function startOsUpdateCheckJob(log) {
  if (upgradeRunning()) {
    throw createAppError('UPDATE_BUSY', 'An OS upgrade is in progress on the host', 'Wait for the upgrade to finish before checking again');
  }
  const running = operationJobStore.findRunningJob(BACKGROUND_JOB_KIND.OS_UPDATE_CHECK, TITLE_OS_UPDATE_CHECK);
  if (running) return { jobId: running.jobId, title: running.title };
  return operationJobStore.startOperationJob({
    kind: BACKGROUND_JOB_KIND.OS_UPDATE_CHECK,
    title: TITLE_OS_UPDATE_CHECK,
    log,
    run: () => checkForUpdates(),
  });
}

function getOsRelease() {
  try {
    const content = readFileSync('/etc/os-release', 'utf8');
    const obj = {};
    for (const line of content.split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) obj[m[1]] = m[2].replace(/^"|"$/g, '').trim();
    }
    return {
      prettyName: obj.PRETTY_NAME || null,
      id: obj.ID || null,
      versionId: obj.VERSION_ID || null,
    };
  } catch {
    /* not Linux or /etc/os-release unreadable */
    return null;
  }
}

export default async function hostRoutes(fastify) {
  fastify.get('/host', {
    config: { auth: 'read' },
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            hostname: { type: 'string' },
            nodeVersion: { type: 'string' },
            libvirtVersion: { type: ['string', 'null'] },
            qemuVersion: { type: ['string', 'null'] },
            wispVersion: { type: 'string' },
            uptimeSeconds: { type: 'number' },
            primaryAddress: { type: ['string', 'null'] },
            kernel: { type: 'string' },
            osRelease: {
              type: ['object', 'null'],
              nullable: true,
              properties: {
                prettyName: { type: ['string', 'null'] },
                id: { type: ['string', 'null'] },
                versionId: { type: ['string', 'null'] },
              },
            },
          },
        },
      },
    },
    handler: async (request) => {
      try {
        const info = await getHostInfo();
        info.wispVersion = getCurrentVersion();
        info.osRelease = getOsRelease();

        try {
          const extra = await getProfilerSoftwareOverview();
          if (extra) {
            if (extra.osRelease) info.osRelease = extra.osRelease;
            if (extra.kernel) info.kernel = extra.kernel;
            if (extra.hostname) info.hostname = extra.hostname;
          }
        } catch (err) {
          /* system_profiler missing, timeout, or JSON error — keep getHostInfo / os-release fields */
          request.log.debug({ err }, 'Darwin SPSoftwareDataType not applied');
        }

        return info;
      } catch (err) {
        throw asAppError(err, 'Failed to get host info');
      }
    },
  });

  // A job (it refreshes the package index): 202 with the job id; the count
  // arrives as the job's `done` payload.
  fastify.post('/host/updates/check', {
    config: { auth: 'admin' },
    schema: { response: JOB_ACCEPTED },
    handler: async (request, reply) => reply.code(202).send(startOsUpdateCheckJob(request.log)),
  });

  fastify.get('/host/updates/packages', {
    config: { auth: 'read' },
    schema: {
      querystring: {
        type: 'object',
        properties: { refresh: { type: ['string', 'number', 'boolean'] } },
      },
      response: {
        ...JOB_ACCEPTED,
        200: {
          type: 'object',
          properties: {
            packages: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  from: { type: ['string', 'null'] },
                  to: { type: 'string' },
                },
              },
            },
            downloadBytes: { type: 'number' },
            cached: { type: 'boolean' },
            lastCheckedAt: { type: ['string', 'null'] },
          },
        },
      },
    },
    handler: async (request, reply) => {
      /* Default: serve the cache (instant; populated by the background hourly
       * check or any prior run). ?refresh=1 starts — or joins — the shared check
       * job and answers 202 with its id; read the list once it is done. With no
       * cache yet, the same. */
      const refresh = request.query?.refresh;
      const wantFresh = refresh === '1' || refresh === 1 || refresh === true || refresh === 'true';
      const cached = wantFresh ? null : await listUpgradablePackages(undefined, { useCache: true, cacheOnly: true });
      if (!cached) return reply.code(202).send(startOsUpdateCheckJob(request.log));
      return cached;
    },
  });

  // A job: an upgrade runs as long as it keeps printing (no total bound). A
  // check or upgrade already running is refused here (409); the outcome, and
  // each output line as progress, arrive over the job's stream.
  fastify.post('/host/updates/upgrade', {
    config: { auth: 'admin' },
    schema: { response: JOB_ACCEPTED },
    handler: async (request, reply) => {
      if (isUpdateOperationInProgress() || upgradeRunning()
        || operationJobStore.findRunningJob(BACKGROUND_JOB_KIND.OS_UPDATE_CHECK, TITLE_OS_UPDATE_CHECK)) {
        throw createAppError('UPDATE_BUSY', 'Another OS update check or upgrade is in progress: wait for it to finish');
      }
      const job = operationJobStore.startOperationJob({
        kind: BACKGROUND_JOB_KIND.OS_UPGRADE,
        title: TITLE_OS_UPGRADE,
        log: request.log,
        run: (report) => performUpgrade(undefined, { onLine: (line) => report({ step: 'upgrading', detail: line }) }),
      });
      return reply.code(202).send(job);
    },
  });

  fastify.get('/host/bridges', {
    config: { auth: 'read' },
    schema: {
      response: {
        200: { type: 'array', items: { type: 'string' } },
      },
    },
    handler: async () => {
      try {
        return await listHostBridges();
      } catch (err) {
        throw asAppError(err, 'Failed to list bridges');
      }
    },
  });

  fastify.get('/host/network-bridges', {
    config: { auth: 'read' },
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            managed: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  baseBridge: { type: 'string' },
                  vlanId: { type: 'number' },
                  vlanInterface: { type: 'string' },
                  file: { type: 'string' },
                  present: { type: 'boolean' },
                },
              },
            },
            eligibleParents: {
              type: 'array',
              items: { type: 'string' },
            },
          },
        },
      },
    },
    handler: async () => {
      const [managed, eligibleParents] = await Promise.all([
        listManagedNetworkBridges(),
        listEligibleParentBridges(),
      ]);
      return { managed, eligibleParents };
    },
  });

  fastify.post('/host/network-bridges', {
    config: { auth: 'admin' },
    schema: {
      body: {
        type: 'object',
        required: ['baseBridge', 'vlanId'],
        properties: {
          baseBridge: { type: 'string', minLength: 1 },
          vlanId: { type: 'number' },
        },
      },
      response: JOB_ACCEPTED,
    },
    // A job: applying netplan can take a while. The request is checked here
    // (format, VLAN range, parent, an existing bridge); the created bridge is
    // the job's `done` payload.
    handler: async (request, reply) => {
      const plan = await planManagedNetworkBridgeCreate(request.body);
      const job = operationJobStore.startOperationJob({
        kind: BACKGROUND_JOB_KIND.NETWORK_BRIDGE_CREATE,
        title: titleForBridgeCreate(`${plan.baseBridge} VLAN ${plan.vlanId}`),
        log: request.log,
        run: async () => {
          const b = await createManagedNetworkBridge(plan);
          return { name: b.name, baseBridge: b.baseBridge, vlanId: b.vlanId, vlanInterface: b.vlanInterface, present: b.present };
        },
      });
      return reply.code(202).send(job);
    },
  });

  fastify.delete('/host/network-bridges/:name', {
    config: { auth: 'admin' },
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1 },
        },
      },
      response: JOB_ACCEPTED,
    },
    // A job, like create: removing the bridge applies netplan. Not found and
    // in use are answered here.
    handler: async (request, reply) => {
      const target = await planManagedNetworkBridgeDelete(request.params.name, { assertNotInUse: assertBridgeNotInUse });
      const job = operationJobStore.startOperationJob({
        kind: BACKGROUND_JOB_KIND.NETWORK_BRIDGE_DELETE,
        title: titleForBridgeDelete(target.bridgeName),
        log: request.log,
        run: () => deleteManagedNetworkBridge(target),
      });
      return reply.code(202).send(job);
    },
  });

  fastify.get('/host/firmware', {
    config: { auth: 'read' },
    schema: {
      response: {
        200: { type: 'array', items: { type: 'string' } },
      },
    },
    handler: async () => {
      try {
        return await listHostFirmware();
      } catch (err) {
        throw asAppError(err, 'Failed to list firmware');
      }
    },
  });

  fastify.get('/host/gpus', {
    config: { auth: 'read' },
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            gpus: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  device: { type: 'string' },
                  vendor: { type: 'string' },
                  vendorName: { type: 'string' },
                  pciSlot: { type: ['string', 'null'] },
                  model: { type: ['string', 'null'] },
                },
              },
            },
          },
        },
      },
    },
    handler: async () => {
      try {
        const gpus = await listHostGpus();
        return { gpus };
      } catch (err) {
        throw asAppError(err, 'Failed to list GPUs');
      }
    },
  });

  fastify.get('/host/usb', {
    config: { auth: 'read' },
    schema: {
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              bus: { type: 'string' },
              device: { type: 'string' },
              vendorId: { type: 'string' },
              productId: { type: 'string' },
              name: { type: 'string' },
            },
          },
        },
      },
    },
    handler: async () => {
      try {
        return getHostUSBDevicesCached();
      } catch (err) {
        throw asAppError(err, 'Failed to list USB devices');
      }
    },
  });

  const diskResponseItem = {
    type: 'object',
    properties: {
      uuid: { type: 'string' },
      devPath: { type: 'string' },
      fsType: { type: 'string' },
      label: { type: 'string' },
      sizeBytes: { type: 'number' },
      removable: { type: 'boolean' },
      vendor: { type: 'string' },
      model: { type: 'string' },
      mountedAt: { type: ['string', 'null'] },
    },
  };

  fastify.get('/host/disks', {
    config: { auth: 'read' },
    schema: {
      response: { 200: { type: 'array', items: diskResponseItem } },
    },
    handler: async () => {
      try {
        return getHostDisksCached();
      } catch (err) {
        throw asAppError(err, 'Failed to list disks');
      }
    },
  });

  // GET /host/disks/stream — SSE: removable/fixed block-device list with mount state.
  fastify.get('/host/disks/stream', {
    config: { auth: 'read' },
    schema: { hide: true },
    handler: async (request, reply) => {
      setupSSE(reply);

      function sendList() {
        try {
          const devices = getHostDisksCached();
          reply.raw.write(`data: ${JSON.stringify(devices)}\n\n`);
        } catch (err) {
          request.log.error({ err }, 'host/disks/stream write failed');
          writeSSEError(reply.raw, err);
        }
      }

      sendList();
      const unsubscribe = onHostDiskChange(sendList);

      onSSEClose(reply, () => {
        unsubscribe();
      });
    },
  });

  // GET /host/usb/stream — SSE: host USB device list (push on hotplug; initial snapshot immediately)
  fastify.get('/host/usb/stream', {
    config: { auth: 'read' },
    schema: { hide: true },
    handler: async (request, reply) => {
      setupSSE(reply);

      function sendList() {
        try {
          const devices = getHostUSBDevicesCached();
          reply.raw.write(`data: ${JSON.stringify(devices)}\n\n`);
        } catch (err) {
          request.log.error({ err }, 'host/usb/stream write failed');
          writeSSEError(reply.raw, err);
        }
      }

      sendList();
      const unsubscribe = onHostUSBChange(sendList);

      onSSEClose(reply, () => {
        unsubscribe();
      });
    },
  });

  fastify.get('/host/hardware', {
    config: { auth: 'read' },
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            cpu: {
              type: ['object', 'null'],
              nullable: true,
              properties: {
                model: { type: 'string' },
                cores: { type: 'number' },
                threads: { type: 'number' },
                mhz: { type: ['number', 'null'] },
                cacheKb: { type: ['number', 'null'] },
                coreTypes: {
                  type: ['object', 'null'],
                  nullable: true,
                  properties: {
                    performance: { type: 'array', items: { type: 'number' } },
                    efficiency: { type: 'array', items: { type: 'number' } },
                  },
                },
              },
            },
            disks: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  model: { type: 'string' },
                  sizeBytes: { type: 'number' },
                  rotational: { type: ['boolean', 'null'] },
                  pciAddress: { type: ['string', 'null'] },
                  smart: {
                    type: 'object',
                    properties: {
                      supported: { type: 'boolean' },
                      overall: { type: 'string' },
                      temperatureC: { type: ['number', 'null'] },
                      powerOnHours: { type: ['number', 'null'] },
                      criticalWarning: { type: ['string', 'null'] },
                      percentageUsed: { type: ['number', 'null'] },
                      availableSpare: { type: ['number', 'null'] },
                      availableSpareThreshold: { type: ['number', 'null'] },
                      reallocatedSectors: { type: ['number', 'null'] },
                      pendingSectors: { type: ['number', 'null'] },
                      offlineUncorrectableSectors: { type: ['number', 'null'] },
                      ssdLifePercentRemaining: { type: ['number', 'null'] },
                      lastUpdated: { type: 'string' },
                      error: { type: ['string', 'null'] },
                    },
                  },
                },
              },
            },
            filesystems: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  mount: { type: 'string' },
                  device: { type: 'string' },
                  totalBytes: { type: 'number' },
                  usedBytes: { type: 'number' },
                  availBytes: { type: 'number' },
                },
              },
            },
            network: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  mac: { type: ['string', 'null'] },
                  speedMbps: { type: ['number', 'null'] },
                  state: { type: 'string' },
                },
              },
            },
            memory: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string' },
                  sizeBytes: { type: 'number' },
                  speedMts: { type: ['number', 'null'] },
                  slot: { type: 'string' },
                  formFactor: { type: ['string', 'null'] },
                  manufacturer: { type: ['string', 'null'] },
                  voltage: { type: ['string', 'null'] },
                },
              },
            },
            pciDevices: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  address: { type: 'string' },
                  classId: { type: 'string' },
                  classCode: { type: 'string' },
                  className: { type: 'string' },
                  vendor: { type: 'string' },
                  vendorId: { type: 'string' },
                  device: { type: 'string' },
                  deviceId: { type: 'string' },
                  driver: { type: ['string', 'null'] },
                },
              },
            },
            system: {
              type: ['object', 'null'],
              nullable: true,
              properties: {
                boardVendor: { type: ['string', 'null'] },
                boardName: { type: ['string', 'null'] },
                boardVersion: { type: ['string', 'null'] },
                systemVendor: { type: ['string', 'null'] },
                systemProduct: { type: ['string', 'null'] },
                systemVersion: { type: ['string', 'null'] },
                biosVendor: { type: ['string', 'null'] },
                biosVersion: { type: ['string', 'null'] },
                biosDate: { type: ['string', 'null'] },
              },
            },
          },
        },
      },
    },
    handler: async () => {
      try {
        return await getHostHardwareInfo();
      } catch (err) {
        throw asAppError(err, 'Failed to get host hardware');
      }
    },
  });

  fastify.post('/host/power/shutdown', {
    config: { auth: 'admin' },
    schema: {
      response: { 204: { type: 'null' } },
    },
    handler: async (request, reply) => {
      await hostShutdown();
      return reply.code(204).send();
    },
  });

  fastify.post('/host/power/restart', {
    config: { auth: 'admin' },
    schema: {
      response: { 204: { type: 'null' } },
    },
    handler: async (request, reply) => {
      await hostReboot();
      return reply.code(204).send();
    },
  });
}
