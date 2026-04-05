/**
 * Host info and host-level queries (bridges, firmware, USB devices).
 */
import { hostname, release, uptime, networkInterfaces, cpus, totalmem } from 'node:os';
import { readdir, access as fsAccess } from 'node:fs/promises';
import { join } from 'node:path';
import { isVlanLikeBridgeName } from '../../bridgeNaming.js';
import { connectionState, getDomainXML, formatVersion, unwrapVariant } from './vmManagerConnection.js';
import { parseVMFromXML } from './vmManagerXml.js';
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
      console.warn('[vmManager] Failed to read versions:', err.message);
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

export async function getRunningVMAllocations() {
  if (!connectionState.connectIface) return { vcpus: 0, memoryBytes: 0, count: 0 };

  try {
    const paths = await connectionState.connectIface.ListDomains(1);
    let vcpus = 0;
    let memoryBytes = 0;

    for (const p of paths) {
      try {
        const xml = await getDomainXML(p);
        const config = parseVMFromXML(xml);
        if (config) {
          vcpus += config.vcpus;
          memoryBytes += config.memoryMiB * 1024 * 1024;
        }
      } catch {
        /* domain may have disappeared between list and query */
      }
    }

    return { vcpus, memoryBytes, count: paths.length };
  } catch (err) {
    /* ListDomains or aggregate failed — return zeros for stats bar */
    console.warn('[vmManager] Failed to get running VM allocations:', err.message);
    return { vcpus: 0, memoryBytes: 0, count: 0 };
  }
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
 * First Linux bridge suitable as macvlan **master**: prefer a name that is not VLAN-style
 * (see `isVlanLikeBridgeName`), else the first listed bridge. Empty when none (e.g. Darwin).
 */
export async function getDefaultMacvlanParentBridge() {
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
