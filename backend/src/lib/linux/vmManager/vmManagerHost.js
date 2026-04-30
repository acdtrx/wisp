/**
 * Host info and host-level queries (bridges, firmware, USB devices).
 */
import { hostname, release, uptime, networkInterfaces, cpus, totalmem } from 'node:os';
import { readdir, access as fsAccess } from 'node:fs/promises';
import { join } from 'node:path';
import { isVlanLikeBridgeName } from '../../bridgeNaming.js';
import { connectionState, formatVersion, unwrapVariant } from './vmManagerConnection.js';
import { getDevices as getHostUSBDevicesFromMonitor } from '../host/usbMonitor.js';

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
  const info = {
    hostname: hostname(),
    nodeVersion: process.version,
    libvirtVersion: null,
    qemuVersion: null,
    uptimeSeconds: uptime(),
    primaryAddress: getPrimaryAddress(),
    kernel: release(),
  };

  if (connectionState.connectIface && connectionState.connectProps) {
    try {
      info.libvirtVersion = formatVersion(unwrapVariant(await connectionState.connectProps.Get('org.libvirt.Connect', 'LibVersion')));
      info.qemuVersion = formatVersion(unwrapVariant(await connectionState.connectProps.Get('org.libvirt.Connect', 'Version')));
    } catch (err) {
      /* libvirt props unavailable — leave version fields null */
      connectionState.logger?.warn?.({ err: err.message }, '[vmManager] Failed to read versions');
    }
  }

  return info;
}

export function getHostHardware() {
  return {
    cores: cpus().length,
    totalMemoryBytes: totalmem(),
  };
}

export async function listHostBridges() {
  try {
    const entries = await readdir('/sys/class/net');
    const bridges = [];
    for (const name of entries) {
      try {
        await fsAccess(`/sys/class/net/${name}/bridge`);
        bridges.push(name);
      } catch { /* not a bridge */ }
    }
    const envBridge = process.env.WISP_DEFAULT_BRIDGE?.trim();
    if (envBridge && bridges.includes(envBridge)) {
      bridges.splice(bridges.indexOf(envBridge), 1);
      bridges.unshift(envBridge);
    } else {
      bridges.sort((a, b) => {
        const aVirbr = a.startsWith('virbr') ? 1 : 0;
        const bVirbr = b.startsWith('virbr') ? 1 : 0;
        return aVirbr - bVirbr;
      });
    }
    return bridges;
  } catch {
    /* /sys/class/net unreadable (non-Linux layout or permissions) */
    return [];
  }
}

/**
 * First Linux bridge suitable as the **parent bridge** for a new container: prefer a name
 * that is not VLAN-style (see `isVlanLikeBridgeName`), else the first listed bridge.
 * Empty when none (e.g. Darwin).
 */
export async function getDefaultContainerParentBridge() {
  const bridges = await listHostBridges();
  if (bridges.length === 0) return undefined;
  const plain = bridges.find((b) => !isVlanLikeBridgeName(b));
  return plain ?? bridges[0];
}

/**
 * Default bridge for new VMs: WISP_DEFAULT_BRIDGE env, or first non-virbr bridge, or virbr0.
 */
export async function getDefaultBridge() {
  const envBridge = process.env.WISP_DEFAULT_BRIDGE?.trim();
  if (envBridge) return envBridge;
  const bridges = await listHostBridges();
  return bridges.length > 0 ? bridges[0] : 'virbr0';
}

export async function listHostFirmware() {
  const searchPaths = [
    '/usr/share/OVMF',
    '/usr/share/edk2/ovmf',
    '/usr/share/edk2/x64',
    '/usr/share/qemu/firmware',
  ];

  const firmware = [];
  for (const dir of searchPaths) {
    try {
      const entries = await readdir(dir);
      for (const entry of entries) {
        if (entry.endsWith('.fd') || entry.endsWith('.bin')) {
          firmware.push(join(dir, entry));
        }
      }
    } catch { /* directory doesn't exist */ }
  }
  return firmware;
}

export async function listHostUSBDevices() {
  return getHostUSBDevicesFromMonitor();
}
