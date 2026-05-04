/**
 * macOS dev stub: no libvirt. Preserves previous IS_DARWIN behavior.
 */
import { hostname, release, uptime, networkInterfaces, cpus, totalmem } from 'node:os';

import { parseDomainRaw, parseVMFromXML } from '../linux/vmManagerXml.js';
import {
  vmError,
  unwrapVariant,
  unwrapDict,
  formatVersion,
  generateMAC,
} from '../vmManagerShared.js';

export { parseVMFromXML };
export const IS_DARWIN = true;

export function configure(_cfg) {
  /* macOS dev stub: no on-disk VM directories. configure() kept symmetric with
     Linux so backend/src/index.js can call it unconditionally. */
}

export const connectionState = {
  bus: null,
  connectIface: null,
  connectProps: null,
  vmStartTimes: new Map(),
  prevVMStats: new Map(),
  onDomainChange: null,
  onDisconnect: null,
};

export { unwrapVariant, unwrapDict, formatVersion, generateMAC, vmError };

function noConn() {
  return vmError('NO_CONNECTION', 'Not connected to libvirt');
}

export async function connect() {
  // Boot-time message before any Pino logger is available; console is
  // intentional here so the dev server's stderr clearly shows that libvirt
  // is offline (vmManager has no logger plumbed yet).
  console.warn('[vmManager] macOS detected — running without libvirt (dev mode)');
}

export function disconnect() {}

export async function getDomainObjAndIface() {
  throw noConn();
}

export async function resolveDomain() {
  throw noConn();
}

export async function getDomainState() {
  throw noConn();
}

export async function getDomainXML() {
  throw noConn();
}

function getPrimaryAddress() {
  const ifaces = networkInterfaces();
  if (!ifaces) return null;
  const skipNames = ['lo'];
  for (const name of Object.keys(ifaces)) {
    if (skipNames.includes(name)) continue;
    const addrs = ifaces[name];
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

export async function getHostInfo() {
  return {
    hostname: hostname(),
    nodeVersion: process.version,
    libvirtVersion: null,
    qemuVersion: null,
    uptimeSeconds: uptime(),
    primaryAddress: getPrimaryAddress(),
    kernel: release(),
  };
}

export function getHostHardware() {
  return {
    cores: cpus().length,
    totalMemoryBytes: totalmem(),
  };
}

export async function getRunningVMAllocations() {
  return { vcpus: 0, memoryBytes: 0, count: 0 };
}

export async function listHostFirmware() {
  return [];
}

export function getCachedLocalDns() {
  return undefined;
}

export function getCachedStaleBinary() {
  return false;
}

export function subscribeVMListChange() {
  return () => {};
}

export function subscribeVMNetworkChange() {
  return () => {};
}

export async function getGuestNetwork() {
  return { ip: null, hostname: null };
}

export async function listVMs() {
  return [];
}

export async function getVMConfig() {
  throw noConn();
}

export async function findVMsUsingImage() {
  return [];
}

export async function startVM() {
  throw noConn();
}

export async function stopVM() {
  throw noConn();
}

export async function forceStopVM() {
  throw noConn();
}

export async function rebootVM() {
  throw noConn();
}

export async function suspendVM() {
  throw noConn();
}

export async function resumeVM() {
  throw noConn();
}

export async function getVMStats() {
  throw noConn();
}

export async function getVMXML() {
  throw noConn();
}

export async function getVNCPort() {
  throw noConn();
}

export async function isVMBinaryStale() {
  return false;
}

export function getWindowsFeatures() {
  return {
    acpi: {},
    hyperv: {
      '@_mode': 'custom',
      relaxed: { '@_state': 'on' },
      vapic: { '@_state': 'on' },
      spinlocks: { '@_state': 'on', '@_retries': '8191' },
      vpindex: { '@_state': 'on' },
      synic: { '@_state': 'on' },
      stimer: { '@_state': 'on' },
      reset: { '@_state': 'on' },
    },
  };
}

export function getWindowsClock() {
  return {
    '@_offset': 'localtime',
    timer: { '@_name': 'hypervclock', '@_present': 'yes' },
  };
}

export function getLinuxFeatures() {
  return { acpi: {} };
}

export async function createVM() {
  throw noConn();
}

export async function deleteVM() {
  throw noConn();
}

export async function cloneVM() {
  throw noConn();
}

export async function updateVMConfig() {
  throw noConn();
}

export async function getVMUSBDevices() {
  return [];
}

export async function attachUSBDevice() {
  throw noConn();
}

export async function detachUSBDevice() {
  throw noConn();
}

export function extractDiskSnippet(fullXml, slot) {
  const parsed = parseDomainRaw(fullXml);
  const disks = parsed?.domain?.devices?.disk;
  if (!Array.isArray(disks)) return null;
  const disk = disks.find((d) => d.target && d.target['@_dev'] === slot);
  return disk || null;
}

export async function attachDisk() {
  throw noConn();
}

export async function createAndAttachDisk() {
  throw noConn();
}

export async function detachDisk() {
  throw noConn();
}

export async function resizeDiskBySlot() {
  throw noConn();
}

export async function updateDiskBus() {
  throw noConn();
}

export async function attachISO() {
  throw noConn();
}

export async function ejectISO() {
  throw noConn();
}

export async function listSnapshots() {
  throw noConn();
}

export async function createSnapshot() {
  throw noConn();
}

export async function revertSnapshot() {
  throw noConn();
}

export async function deleteSnapshot() {
  throw noConn();
}

export async function createBackup() {
  throw noConn();
}

export async function listBackups() {
  throw noConn();
}

export async function deleteBackup() {
  throw noConn();
}

export async function restoreBackup() {
  throw noConn();
}
