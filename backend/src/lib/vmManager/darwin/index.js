/**
 * macOS dev stub: no libvirt. Preserves previous IS_DARWIN behavior.
 */
import { hostname, release, uptime, networkInterfaces, cpus, totalmem } from 'node:os';

import { parseVMFromXML } from '../linux/vmManagerXml.js';
import { vmError } from '../vmManagerShared.js';

export { parseVMFromXML };
export { isOfflineState } from '../linux/libvirtConstants.js';
export const IS_DARWIN = true;

export function configure(_cfg) {
  /* macOS dev stub: no on-disk VM directories. configure() kept symmetric with
     Linux so backend/src/index.js can call it unconditionally. */
}

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

function getPrimaryAddress() {
  const ifaces = networkInterfaces();
  if (!ifaces) return null;
  const skipNames = ['lo'];
  for (const name of Object.keys(ifaces)) {
    if (skipNames.includes(name)) continue;
    const addrs = ifaces[name];
    if (!addrs) continue;
    for (const a of addrs) {
      // Skip link-local (169.254.0.0/16), consistent with the Linux host-info path.
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) return a.address;
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

export async function assertVMNameAvailable() {
  throw noConn();
}

export async function createVM() {
  throw noConn();
}

export async function deleteVM() {
  throw noConn();
}

export async function updateVMConfig() {
  throw noConn();
}

export async function setVMPendingRestart() {
  throw noConn();
}

export async function getGraphicsListen() {
  throw noConn();
}

export async function setGraphicsListen() {
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

export async function resolveVmBackupDir() {
  throw noConn();
}

/* Pure filesystem work over caller-supplied roots — real on macOS too. */
export { tightenVMBackupFileModes } from '../linux/vmManagerBackupModes.js';
