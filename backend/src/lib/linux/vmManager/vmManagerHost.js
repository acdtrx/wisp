/**
 * Host info and host-level queries (firmware). Bridge enumeration lives in
 * `lib/networking/`; USB enumeration lives in `lib/host/` and is consumed
 * directly by the route layer.
 */
import { hostname, release, uptime, networkInterfaces, cpus, totalmem } from 'node:os';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { connectionState, formatVersion, unwrapVariant } from './vmManagerConnection.js';

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
