/**
 * CDROM / ISO attach and eject.
 * XML handled via fast-xml-parser (parse/build), not regex.
 */
import {
  resolveDomain,
  getDomainState,
  getDomainXML,
  getDomainObjAndIface,
  vmError,
} from './vmManagerConnection.js';
import { extractDiskSnippet } from './vmManagerDisk.js';
import { buildDiskXml, setWispPendingRestart } from './vmManagerXml.js';
import { refreshVMListCache } from './vmManagerList.js';
import { redefineVM } from './vmManagerDefine.js';
import { cdromElement } from './vmManagerDevices.js';
import { isShutOff } from './libvirtConstants.js';

/**
 * Attach an ISO to a CDROM slot.
 *
 * @param {string} name - VM name
 * @param {string} slot - target dev (e.g. 'sdc', 'sdd', 'sde')
 * @param {string} isoPath - absolute path to the ISO file (route-validated)
 * @param {{ createIfMissing?: boolean }} [opts] - if `createIfMissing` is true and the
 *   slot doesn't exist in the domain XML, the slot is created (sata, readonly cdrom) in
 *   the saved definition instead of throwing DISK_NOT_FOUND; a VM that is on gets the
 *   restart-required flag. Used by cloud-init's first-enable path where the sde slot
 *   may not exist yet.
 */
export async function attachISO(name, slot, isoPath, opts = {}) {
  const { createIfMissing = false } = opts;
  const domPath = await resolveDomain(name);
  const state = await getDomainState(domPath);
  const { iface } = await getDomainObjAndIface(domPath);
  const isOn = !isShutOff(state.code);

  const fullXml = await getDomainXML(domPath);
  const disk = extractDiskSnippet(fullXml, slot);

  if (!disk) {
    if (!createIfMissing) {
      throw vmError('DISK_NOT_FOUND', `CDROM slot ${slot} not found in VM "${name}"`);
    }
    // A new SATA CD-ROM cannot be hot-plugged: the slot is added to the saved
    // definition, whatever the state, and a VM that is on gets it at its next
    // start (flagged, as an edit is). The saved definition may already hold the
    // slot, added while the VM ran: its media is set there.
    await redefineVM(domPath, (dom) => {
      if (!dom.devices) throw vmError('PARSE_ERROR', 'Invalid domain XML');
      const disks = Array.isArray(dom.devices.disk) ? dom.devices.disk : dom.devices.disk ? [dom.devices.disk] : [];
      const saved = disks.find((d) => d.target?.['@_dev'] === slot);
      if (saved) {
        saved['@_type'] = 'file';
        saved.source = { '@_file': isoPath };
      } else {
        dom.devices.disk = [...disks, cdromElement({ slot, path: isoPath })];
      }
      if (isOn) setWispPendingRestart(dom, new Date().toISOString());
    }, {
      defineError: (err) => vmError('LIBVIRT_ERROR', `Failed to attach ISO to ${slot}`, err.message),
    });
    if (isOn) refreshVMListCache();
    return;
  }

  disk['@_type'] = 'file';
  disk.source = { '@_file': isoPath };

  const flags = isOn ? 3 : 2;
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
 * @param {{ removeSlot?: boolean }} [opts] - if `removeSlot` is true: a missing slot
 *   is already done (no DISK_NOT_FOUND), and on an offline VM the device is removed
 *   from the domain XML entirely. Used by cloud-init's detach path to clean up the
 *   sde entry when cloud-init is disabled. A step that fails fails the eject.
 */
export async function ejectISO(name, slot, opts = {}) {
  const { removeSlot = false } = opts;
  const domPath = await resolveDomain(name);
  const state = await getDomainState(domPath);
  const { iface } = await getDomainObjAndIface(domPath);
  const isOn = !isShutOff(state.code);

  const fullXml = await getDomainXML(domPath);
  const disk = extractDiskSnippet(fullXml, slot);
  if (!disk) {
    if (removeSlot) return;
    throw vmError('DISK_NOT_FOUND', `CDROM slot ${slot} not found in VM "${name}"`);
  }

  delete disk.source;

  const flags = isOn ? 3 : 2;
  try {
    await iface.UpdateDevice(buildDiskXml(disk), flags);
  } catch (err) {
    throw vmError('LIBVIRT_ERROR', `Failed to eject ${slot}`, err.message);
  }

  if (removeSlot && !isOn) {
    await redefineVM(domPath, (dom) => {
      if (!dom.devices?.disk) return false;
      const disks = Array.isArray(dom.devices.disk) ? dom.devices.disk : [dom.devices.disk];
      dom.devices.disk = disks.filter((d) => !d.target || d.target['@_dev'] !== slot);
      return true;
    }, {
      defineError: (err) => vmError('LIBVIRT_ERROR', `Failed to remove ${slot}`, err.message),
    });
  }
}
