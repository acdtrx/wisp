/**
 * CDROM / ISO attach and eject.
 * XML handled via fast-xml-parser (parse/build), not regex.
 */
import { resolveDomain, getDomainState, getDomainXML, getDomainObjAndIface, vmError } from './vmManagerConnection.js';
import { extractDiskSnippet } from './vmManagerDisk.js';
import { buildDiskXml } from './vmManagerXml.js';

export async function attachISO(name, slot, isoPath) {
  const domPath = await resolveDomain(name);
  const state = await getDomainState(domPath);
  const { iface } = await getDomainObjAndIface(domPath);
  const isRunning = state.code === 1 || state.code === 2;

  const fullXml = await getDomainXML(domPath);
  const disk = extractDiskSnippet(fullXml, slot);
  if (!disk) {
    throw vmError('DISK_NOT_FOUND', `CDROM slot ${slot} not found in VM "${name}"`);
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

export async function ejectISO(name, slot) {
  const domPath = await resolveDomain(name);
  const state = await getDomainState(domPath);
  const { iface } = await getDomainObjAndIface(domPath);
  const isRunning = state.code === 1 || state.code === 2;

  const fullXml = await getDomainXML(domPath);
  const disk = extractDiskSnippet(fullXml, slot);
  if (!disk) {
    throw vmError('DISK_NOT_FOUND', `CDROM slot ${slot} not found in VM "${name}"`);
  }

  delete disk.source;

  const flags = isRunning ? 3 : 2;
  try {
    await iface.UpdateDevice(buildDiskXml(disk), flags);
  } catch (err) {
    throw vmError('LIBVIRT_ERROR', `Failed to eject ${slot}`, err.message);
  }
}
