import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';

import {
  getHostInfo,
  listHostFirmware,
} from '../lib/vmManager/index.js';
import {
  listHostBridges,
  listManagedNetworkBridges,
  listEligibleParentBridges,
  createManagedNetworkBridge,
  deleteManagedNetworkBridge,
} from '../lib/networking/index.js';
import {
  checkForUpdates,
  performUpgrade,
  listUpgradablePackages,
  getHostHardwareInfo,
  hostShutdown,
  hostReboot,
  listHostGpus,
  getDevices as getHostUSBDevicesCached,
  onChange as onHostUSBChange,
} from '../lib/host/index.js';
import { handleRouteError, sendError } from '../lib/routeErrors.js';
import { setupSSE } from '../lib/sse.js';
import { getDevices as getHostDisksCached, onChange as onHostDiskChange } from '../lib/storage/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function getWispVersion() {
  try {
    const pkgPath = resolve(__dirname, '../../package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    /* package.json missing or unreadable — show placeholder version */
    return '0.0.0';
  }
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
    handler: async (request, reply) => {
      try {
        const info = await getHostInfo();
        info.wispVersion = getWispVersion();
        info.osRelease = getOsRelease();

        if (platform() === 'darwin') {
          try {
            const { getDarwinSoftwareFromProfiler } = await import('../lib/host/darwin/systemProfilerSoftware.js');
            const extra = await getDarwinSoftwareFromProfiler();
            if (extra) {
              if (extra.osRelease) info.osRelease = extra.osRelease;
              if (extra.kernel) info.kernel = extra.kernel;
              if (extra.hostname) info.hostname = extra.hostname;
            }
          } catch (err) {
            /* system_profiler missing, timeout, or JSON error — keep getHostInfo / os-release fields */
            request.log.debug({ err }, 'Darwin SPSoftwareDataType not applied');
          }
        }

        return info;
      } catch (err) {
        request.log.error({ err }, 'GET /host failed');
        sendError(reply, 500, 'Failed to get host info', err.message);
      }
    },
  });

  /* Map osUpdates error codes to HTTP status:
   *   UPDATE_BUSY            → 409 (transient: another op is running, retry later)
   *   UPDATE_CHECK_UNAVAILABLE → 503 (script missing, sudo refused, parser error)
   *   anything else          → 500 */
  function osUpdateErrorStatus(err) {
    if (err.code === 'UPDATE_BUSY') return 409;
    if (err.code === 'UPDATE_CHECK_UNAVAILABLE') return 503;
    return 500;
  }

  fastify.post('/host/updates/check', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: { count: { type: 'number' } },
        },
      },
    },
    handler: async (request, reply) => {
      try {
        return await checkForUpdates();
      } catch (err) {
        request.log.error({ err }, 'POST /host/updates/check failed');
        reply.code(osUpdateErrorStatus(err)).send({
          error: err.message || 'Update check failed',
          detail: err.raw || err.detail || err.message,
          code: err.code,
        });
      }
    },
  });

  fastify.get('/host/updates/packages', {
    schema: {
      querystring: {
        type: 'object',
        properties: { refresh: { type: ['string', 'number', 'boolean'] } },
      },
      response: {
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
      /* Default: serve cache when available (instant; populated by background hourly check
       * or any prior call). ?refresh=1 forces a fresh apt invocation. */
      const refresh = request.query?.refresh;
      const useCache = !(refresh === '1' || refresh === 1 || refresh === true || refresh === 'true');
      try {
        return await listUpgradablePackages(undefined, { useCache });
      } catch (err) {
        request.log.error({ err }, 'GET /host/updates/packages failed');
        reply.code(osUpdateErrorStatus(err)).send({
          error: err.message || 'Package list failed',
          detail: err.raw || err.detail || err.message,
          code: err.code,
        });
      }
    },
  });

  fastify.post('/host/updates/upgrade', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
        },
      },
    },
    handler: async (request, reply) => {
      try {
        return await performUpgrade();
      } catch (err) {
        request.log.error({ err }, 'POST /host/updates/upgrade failed');
        reply.code(osUpdateErrorStatus(err)).send({
          error: err.message || 'Upgrade failed',
          detail: err.raw || err.detail || err.message,
          code: err.code,
        });
      }
    },
  });

  fastify.get('/host/bridges', {
    schema: {
      response: {
        200: { type: 'array', items: { type: 'string' } },
      },
    },
    handler: async (request, reply) => {
      try {
        return await listHostBridges();
      } catch (err) {
        request.log.error({ err }, 'GET /host/bridges failed');
        sendError(reply, 500, 'Failed to list bridges', err.message);
      }
    },
  });

  fastify.get('/host/network-bridges', {
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
    handler: async (request, reply) => {
      try {
        const [managed, eligibleParents] = await Promise.all([
          listManagedNetworkBridges(),
          listEligibleParentBridges(),
        ]);
        return { managed, eligibleParents };
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  fastify.post('/host/network-bridges', {
    schema: {
      body: {
        type: 'object',
        required: ['baseBridge', 'vlanId'],
        properties: {
          baseBridge: { type: 'string', minLength: 1 },
          vlanId: { type: 'number' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            baseBridge: { type: 'string' },
            vlanId: { type: 'number' },
            vlanInterface: { type: 'string' },
            present: { type: 'boolean' },
          },
        },
      },
    },
    handler: async (request, reply) => {
      try {
        return await createManagedNetworkBridge(request.body);
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  fastify.delete('/host/network-bridges/:name', {
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1 },
        },
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
        return await deleteManagedNetworkBridge(request.params.name);
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  fastify.get('/host/firmware', {
    schema: {
      response: {
        200: { type: 'array', items: { type: 'string' } },
      },
    },
    handler: async (request, reply) => {
      try {
        return await listHostFirmware();
      } catch (err) {
        request.log.error({ err }, 'GET /host/firmware failed');
        sendError(reply, 500, 'Failed to list firmware', err.message);
      }
    },
  });

  fastify.get('/host/gpus', {
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
    handler: async (request, reply) => {
      try {
        const gpus = await listHostGpus();
        return { gpus };
      } catch (err) {
        request.log.error({ err }, 'GET /host/gpus failed');
        sendError(reply, 500, 'Failed to list GPUs', err.message);
      }
    },
  });

  fastify.get('/host/usb', {
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
    handler: async (request, reply) => {
      try {
        return getHostUSBDevicesCached();
      } catch (err) {
        request.log.error({ err }, 'GET /host/usb failed');
        sendError(reply, 500, 'Failed to list USB devices', err.message);
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
    schema: {
      response: { 200: { type: 'array', items: diskResponseItem } },
    },
    handler: async (request, reply) => {
      try {
        return getHostDisksCached();
      } catch (err) {
        request.log.error({ err }, 'GET /host/disks failed');
        sendError(reply, 500, 'Failed to list disks', err.message);
      }
    },
  });

  // GET /host/disks/stream — SSE: removable/fixed block-device list with mount state.
  fastify.get('/host/disks/stream', {
    schema: { hide: true },
    handler: async (request, reply) => {
      setupSSE(reply);

      function sendList() {
        try {
          const devices = getHostDisksCached();
          reply.raw.write(`data: ${JSON.stringify(devices)}\n\n`);
        } catch (err) {
          request.log.error({ err }, 'host/disks/stream write failed');
          const payload = { error: 'Failed to list disks', detail: err.message };
          reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
      }

      sendList();
      const unsubscribe = onHostDiskChange(sendList);

      request.raw.on('close', () => {
        unsubscribe();
      });
    },
  });

  // GET /host/usb/stream — SSE: host USB device list (push on hotplug; initial snapshot immediately)
  fastify.get('/host/usb/stream', {
    schema: { hide: true },
    handler: async (request, reply) => {
      setupSSE(reply);

      function sendList() {
        try {
          const devices = getHostUSBDevicesCached();
          reply.raw.write(`data: ${JSON.stringify(devices)}\n\n`);
        } catch (err) {
          request.log.error({ err }, 'host/usb/stream write failed');
          const payload = { error: 'Failed to list USB devices', detail: err.message };
          reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
      }

      sendList();
      const unsubscribe = onHostUSBChange(sendList);

      request.raw.on('close', () => {
        unsubscribe();
      });
    },
  });

  fastify.get('/host/hardware', {
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
    handler: async (request, reply) => {
      try {
        return await getHostHardwareInfo();
      } catch (err) {
        request.log.error({ err }, 'GET /host/hardware failed');
        sendError(reply, 500, 'Failed to get host hardware', err.message);
      }
    },
  });

  fastify.post('/host/power/shutdown', {
    schema: {
      response: {
        200: { type: 'object', properties: { ok: { type: 'boolean' } } },
      },
    },
    handler: async (request, reply) => {
      try {
        return await hostShutdown();
      } catch (err) {
        request.log.error({ err }, 'POST /host/power/shutdown failed');
        const code = err.code === 'POWER_UNAVAILABLE' ? 503 : 500;
        reply.code(code).send({
          error: err.message || 'Shutdown failed',
          detail: err.raw || err.detail || err.message,
        });
      }
    },
  });

  fastify.post('/host/power/restart', {
    schema: {
      response: {
        200: { type: 'object', properties: { ok: { type: 'boolean' } } },
      },
    },
    handler: async (request, reply) => {
      try {
        return await hostReboot();
      } catch (err) {
        request.log.error({ err }, 'POST /host/power/restart failed');
        const code = err.code === 'POWER_UNAVAILABLE' ? 503 : 500;
        reply.code(code).send({
          error: err.message || 'Reboot failed',
          detail: err.raw || err.detail || err.message,
        });
      }
    },
  });
}
