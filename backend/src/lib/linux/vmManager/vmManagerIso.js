/**
 * CDROM / ISO attach and eject.
 * XML handled via fast-xml-parser (parse/build), not regex.
 */
import {
  connectionState,
  resolveDomain,
  getDomainState,
  getDomainXML,
  getDomainObjAndIface,
  vmError,
} from './vmManagerConnection.js';
import { extractDiskSnippet } from './vmManagerDisk.js';
import { parseDomainRaw, buildDiskXml, buildXml } from './vmManagerXml.js';

/**
 * Attach an ISO to a CDROM slot.
 *
 * @param {string} name - VM name
 * @param {string} slot - target dev (e.g. 'sdc', 'sdd', 'sde')
 * @param {string} isoPath - absolute path to the ISO file (route-validated)
 * @param {{ createIfMissing?: boolean }} [opts] - if `createIfMissing` is true and the
 *   slot doesn't exist in the domain XML, the slot is created (sata, readonly cdrom)
 *   instead of throwing DISK_NOT_FOUND. Used by cloud-init's first-enable path where
 *   the sde slot may not exist yet.
 */
export async function attachISO(name, slot, isoPath, opts = {}) {
  const { createIfMissing = false } = opts;
  const domPath = await resolveDomain(name);
  const state = await getDomainState(domPath);
  const { iface } = await getDomainObjAndIface(domPath);
  const isRunning = state.code === 1 || state.code === 2;

  const fullXml = await getDomainXML(domPath);
  const disk = extractDiskSnippet(fullXml, slot);

  if (!disk) {
    if (!createIfMissing) {
      throw vmError('DISK_NOT_FOUND', `CDROM slot ${slot} not found in VM "${name}"`);
    }
    const newDisk = {
      '@_type': 'file',
      '@_device': 'cdrom',
      driver: { '@_name': 'qemu', '@_type': 'raw' },
      source: { '@_file': isoPath },
      target: { '@_dev': slot, '@_bus': 'sata' },
      readonly: {},
    };
    if (isRunning) {
      try {
        await iface.AttachDevice(buildDiskXml(newDisk), 3);
      } catch (err) {
        throw vmError('LIBVIRT_ERROR', `Failed to attach ISO to ${slot}`, err.message);
      }
      return;
    }
    const parsed = parseDomainRaw(fullXml);
    const dom = parsed?.domain;
    if (!dom?.devices) throw vmError('PARSE_ERROR', 'Invalid domain XML');
    const disks = Array.isArray(dom.devices.disk) ? dom.devices.disk : [dom.devices.disk];
    dom.devices.disk = [...disks, newDisk];
    try {
      await connectionState.connectIface.DomainDefineXML(buildXml(parsed));
    } catch (err) {
      throw vmError('LIBVIRT_ERROR', `Failed to attach ISO to ${slot}`, err.message);
    }
    return;
  }

  disk['@_type'] = 'file';
  disk.source = { '@_file': isoPath };

  const flags = isRunning ? 3 : 2;
  try {
    await iface.UpdateDevice(buildDiskXml(disk), flags);
  } catch (err) {
    throw vmError('LIBVIRT_ERROR', `Failed to attach ISO to ${slot}`, err.message);
  }
}

/**
 * Eject the ISO from a CDROM slot.
 *
 * @param {string} name - VM name
 * @param {string} slot - target dev
 * @param {{ removeSlot?: boolean }} [opts] - if `removeSlot` is true: missing slot
 *   returns silently (no DISK_NOT_FOUND), live UpdateDevice failures are swallowed,
 *   and on an offline VM the device is removed from the domain XML entirely. Used by
 *   cloud-init's detach path to clean up the sde entry when cloud-init is disabled.
 */
export async function ejectISO(name, slot, opts = {}) {
  const { removeSlot = false } = opts;
  const domPath = await resolveDomain(name);
  const state = await getDomainState(domPath);
  const { iface } = await getDomainObjAndIface(domPath);
  const isRunning = state.code === 1 || state.code === 2;

  const fullXml = await getDomainXML(domPath);
  const disk = extractDiskSnippet(fullXml, slot);
  if (!disk) {
    if (removeSlot) return;
    throw vmError('DISK_NOT_FOUND', `CDROM slot ${slot} not found in VM "${name}"`);
  }

  delete disk.source;

  const flags = isRunning ? 3 : 2;
  try {
    await iface.UpdateDevice(buildDiskXml(disk), flags);
  } catch (err) {
    if (!removeSlot) throw vmError('LIBVIRT_ERROR', `Failed to eject ${slot}`, err.message);
    /* removeSlot best-effort: live UpdateDevice may fail when the VM state disallows
       a hot eject; the offline-remove path below handles the cleanup if applicable. */
  }

  if (removeSlot && !isRunning) {
    const parsed = parseDomainRaw(fullXml);
    const dom = parsed?.domain;
    if (dom?.devices?.disk) {
      const disks = Array.isArray(dom.devices.disk) ? dom.devices.disk : [dom.devices.disk];
      const filtered = disks.filter((d) => !d.target || d.target['@_dev'] !== slot);
      dom.devices.disk = filtered.length === 1 ? filtered[0] : filtered;
      try {
        await connectionState.connectIface.DomainDefineXML(buildXml(parsed));
      } catch {
        /* best-effort define after detach — slot's source already cleared above */
      }
    }
  }
}
