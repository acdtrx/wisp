/**
 * VM disk operations: attach, detach, resize; create-and-attach new disk; CDROM/ISO slot extraction helper.
 * XML is handled via fast-xml-parser (parse/build), not regex.
 */
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { connectionState, resolveDomain, getDomainState, getDomainXML, vmError } from './vmManagerConnection.js';
import { parseDomainRaw, parseVMFromXML, buildXml } from './vmManagerXml.js';
import { getVMBasePath } from './vmManagerPaths.js';
import { resizeDisk as resizeDiskImage } from '../../storage/index.js';

const execFile = promisify(execFileCb);

const DISK_BUS_ENUM = ['virtio', 'scsi', 'sata', 'ide'];

/** Ensure a virtio-scsi controller exists when a disk uses bus scsi. */
function ensureVirtioScsiController(dom) {
  if (!dom?.devices) return;
  const controllers = dom.devices.controller;
  const hasScsi = Array.isArray(controllers)
    ? controllers.some((c) => c['@_type'] === 'scsi')
    : controllers && controllers['@_type'] === 'scsi';
  if (!hasScsi) {
    const controller = { '@_type': 'scsi', '@_model': 'virtio-scsi', '@_index': '0' };
    dom.devices.controller = Array.isArray(dom.devices.controller)
      ? [...dom.devices.controller, controller]
      : dom.devices.controller
        ? [dom.devices.controller, controller]
        : controller;
  }
}

/** Return the parsed disk object for the given slot (e.g. 'sdc', 'sde') or null. */
export function extractDiskSnippet(fullXml, slot) {
  const parsed = parseDomainRaw(fullXml);
  const disks = parsed?.domain?.devices?.disk;
  if (!Array.isArray(disks)) return null;
  const disk = disks.find((d) => d.target && d.target['@_dev'] === slot);
  return disk || null;
}

export async function attachDisk(name, slot, imagePath, bus = 'virtio') {
  /* imagePath is caller-provided absolute (route validated). */
  const domPath = await resolveDomain(name);
  const state = await getDomainState(domPath);
  if (state.code !== 5 && state.code !== 0) {
    throw vmError('VM_MUST_BE_OFFLINE', `VM "${name}" must be stopped to attach disks`);
  }

  const xml = await getDomainXML(domPath);
  const parsed = parseDomainRaw(xml);
  const dom = parsed?.domain;
  if (!dom?.devices) throw vmError('PARSE_ERROR', 'Invalid domain XML');

  if (bus === 'scsi') {
    ensureVirtioScsiController(dom);
  }

  const newDisk = {
    '@_type': 'file',
    '@_device': 'disk',
    driver: { '@_name': 'qemu', '@_type': 'qcow2' },
    source: { '@_file': imagePath },
    target: { '@_dev': slot, '@_bus': bus },
  };
  dom.devices.disk = Array.isArray(dom.devices.disk)
    ? [...dom.devices.disk, newDisk]
    : dom.devices.disk
      ? [dom.devices.disk, newDisk]
      : [newDisk];

  try {
    await connectionState.connectIface.DomainDefineXML(buildXml(parsed));
  } catch (err) {
    throw vmError('LIBVIRT_ERROR', `Failed to attach disk to ${slot}`, err.message);
  }
}

/** Create a new empty qcow2 disk in the VM directory and attach it to the given slot. VM must be stopped. */
export async function createAndAttachDisk(name, slot, sizeGB, bus = 'virtio') {
  const vmBasePath = getVMBasePath(name);
  const diskFile = slot === 'sda' ? 'disk0.qcow2' : 'disk1.qcow2';
  const diskPath = join(vmBasePath, diskFile);
  const sizeG = Math.max(1, parseInt(sizeGB, 10) || 32);
  await execFile('qemu-img', ['create', '-f', 'qcow2', diskPath, `${sizeG}G`]);
  await attachDisk(name, slot, diskPath, bus);
}

export async function detachDisk(name, slot) {
  const domPath = await resolveDomain(name);
  const state = await getDomainState(domPath);
  if (state.code !== 5 && state.code !== 0) {
    throw vmError('VM_MUST_BE_OFFLINE', `VM "${name}" must be stopped to detach disks`);
  }

  const xml = await getDomainXML(domPath);
  const parsed = parseDomainRaw(xml);
  const dom = parsed?.domain;
  if (!dom?.devices?.disk) throw vmError('DISK_NOT_FOUND', `No disk found at slot ${slot}`);

  const disks = Array.isArray(dom.devices.disk) ? dom.devices.disk : [dom.devices.disk];
  const filtered = disks.filter((d) => !d.target || d.target['@_dev'] !== slot);
  if (filtered.length === disks.length) {
    throw vmError('DISK_NOT_FOUND', `No disk found at slot ${slot}`);
  }
  dom.devices.disk = filtered.length === 1 ? filtered[0] : filtered;

  try {
    await connectionState.connectIface.DomainDefineXML(buildXml(parsed));
  } catch (err) {
    throw vmError('LIBVIRT_ERROR', `Failed to detach disk ${slot}`, err.message);
  }
}

export async function resizeDiskBySlot(name, slot, sizeGB) {
  const domPath = await resolveDomain(name);
  const state = await getDomainState(domPath);
  if (state.code !== 5 && state.code !== 0) {
    throw vmError('VM_MUST_BE_OFFLINE', `VM "${name}" must be stopped to resize disks`);
  }

  const xml = await getDomainXML(domPath);
  const config = parseVMFromXML(xml);
  const disk = config?.disks?.find(d => d.slot === slot && d.device === 'disk');
  if (!disk || !disk.source) {
    throw vmError('DISK_NOT_FOUND', `No disk found at slot ${slot}`);
  }

  return resizeDiskImage(disk.source, sizeGB);
}

/** Update target bus for an existing block disk (VM must be stopped). */
export async function updateDiskBus(name, slot, bus) {
  if (!DISK_BUS_ENUM.includes(bus)) {
    throw vmError('INVALID_REQUEST', `Invalid disk bus: ${bus}`);
  }

  const domPath = await resolveDomain(name);
  const state = await getDomainState(domPath);
  if (state.code !== 5 && state.code !== 0) {
    throw vmError('VM_MUST_BE_OFFLINE', `VM "${name}" must be stopped to change disk bus`);
  }

  const xml = await getDomainXML(domPath);
  const parsed = parseDomainRaw(xml);
  const dom = parsed?.domain;
  if (!dom?.devices?.disk) {
    throw vmError('DISK_NOT_FOUND', `No disks in VM "${name}"`);
  }

  const disks = Array.isArray(dom.devices.disk) ? dom.devices.disk : [dom.devices.disk];
  const disk = disks.find((d) => d.target?.['@_dev'] === slot && d['@_device'] === 'disk');
  if (!disk) {
    throw vmError('DISK_NOT_FOUND', `No block disk at slot ${slot}`);
  }

  const currentBus = disk.target?.['@_bus'] || 'virtio';
  if (currentBus === bus) {
    return { ok: true };
  }

  if (bus === 'scsi') {
    ensureVirtioScsiController(dom);
  }

  disk.target = disk.target || {};
  disk.target['@_dev'] = slot;
  disk.target['@_bus'] = bus;

  try {
    await connectionState.connectIface.DomainDefineXML(buildXml(parsed));
  } catch (err) {
    throw vmError('LIBVIRT_ERROR', `Failed to update disk bus for ${slot}`, err.message);
  }

  return { ok: true };
}
