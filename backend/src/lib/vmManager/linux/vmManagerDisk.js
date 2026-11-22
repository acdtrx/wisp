/**
 * VM disk operations: attach, detach, resize; create-and-attach new disk; CDROM/ISO slot extraction helper.
 * XML is handled via fast-xml-parser (parse/build), not regex.
 */
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { open, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveDomain, getDomainState, getDomainXML, vmError } from './vmManagerConnection.js';
import { redefineVM } from './vmManagerDefine.js';
import { blockDiskElement, ensureScsiController } from './vmManagerDevices.js';
import { parseDomainRaw, parseVMFromXML } from './vmManagerXml.js';
import { getVMBasePath } from './vmManagerPaths.js';
import { isShutOff } from './libvirtConstants.js';
import { resizeDisk as resizeDiskImage, imageFormatForFile, inspectDiskImage } from '../../storage/index.js';

const execFile = promisify(execFileCb);

/** Return the parsed disk object for the given slot (e.g. 'sdc', 'sde') or null. */
export function extractDiskSnippet(fullXml, slot) {
  const parsed = parseDomainRaw(fullXml);
  const disks = parsed?.domain?.devices?.disk;
  if (!Array.isArray(disks)) return null;
  const disk = disks.find((d) => d.target && d.target['@_dev'] === slot);
  return disk || null;
}

/** Block-disk slots a VM may carry (sdc/sdd/sde are the CDROM slots). */
const DISK_SLOT_ENUM = ['sda', 'sdb'];

/** Disks of the parsed domain, as a list. */
function diskList(dom) {
  return Array.isArray(dom.devices.disk) ? dom.devices.disk : dom.devices.disk ? [dom.devices.disk] : [];
}

/**
 * Check a block-disk attach target before any side effect: a known slot
 * (INVALID_REQUEST), a shut-off VM (VM_MUST_BE_OFFLINE) and a free slot
 * (DISK_SLOT_IN_USE, checked again where the disk is added). Returns the domain
 * path.
 */
async function assertDiskAttachTarget(name, slot) {
  if (!DISK_SLOT_ENUM.includes(slot)) {
    throw vmError('INVALID_REQUEST', `Invalid disk slot: ${slot} (expected ${DISK_SLOT_ENUM.join(' or ')})`);
  }
  const domPath = await resolveDomain(name);
  const state = await getDomainState(domPath);
  if (!isShutOff(state.code)) {
    throw vmError('VM_MUST_BE_OFFLINE', `VM "${name}" must be stopped to attach disks`);
  }
  assertSlotFree(parseDomainRaw(await getDomainXML(domPath, { inactive: true })).domain, name, slot);
  return domPath;
}

function assertSlotFree(dom, name, slot) {
  if (!dom?.devices) throw vmError('PARSE_ERROR', 'Invalid domain XML');
  if (diskList(dom).some((d) => d.target?.['@_dev'] === slot)) {
    throw vmError('DISK_SLOT_IN_USE', `Slot ${slot} of VM "${name}" is already in use — detach it first`);
  }
}

/** Add the block disk to the saved definition, the slot checked free under the write queue. */
async function defineWithNewDisk(domPath, name, slot, imagePath, bus, format) {
  await redefineVM(domPath, (dom) => {
    assertSlotFree(dom, name, slot);
    if (bus === 'scsi') ensureScsiController(dom);
    dom.devices.disk = [...diskList(dom), blockDiskElement({ slot, bus, path: imagePath, format })];
  }, {
    defineError: (err) => vmError('LIBVIRT_ERROR', `Failed to attach disk to ${slot}`, err.message),
  });
}

/**
 * Reserve the lowest-numbered `disk<N>.qcow2` that does not exist yet in the VM
 * directory. The exclusive create (`wx`) makes the reservation atomic, so an
 * existing image — attached, detached-but-kept, or racing request — is never
 * overwritten by the `qemu-img create` that follows.
 */
async function reserveNewDiskFile(vmBasePath) {
  for (let n = 0; ; n++) {
    const diskPath = join(vmBasePath, `disk${n}.qcow2`);
    try {
      const fh = await open(diskPath, 'wx');
      await fh.close();
      return diskPath;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
}

export async function attachDisk(name, slot, imagePath, bus = 'virtio') {
  /* imagePath is caller-provided absolute (route validated); its content is
     not. The domain opens it as the format its name gives (`<driver type>`),
     and an image that would pull other host files into the VM is refused. */
  const domPath = await assertDiskAttachTarget(name, slot);
  const format = await imageFormatForFile(imagePath);
  await inspectDiskImage(imagePath, { format });
  await defineWithNewDisk(domPath, name, slot, imagePath, bus, format);
}

/**
 * Create a new empty qcow2 disk in the VM directory and attach it to the given slot.
 * VM must be stopped and the slot free; all checks run before any file is created.
 */
export async function createAndAttachDisk(name, slot, sizeGB, bus = 'virtio') {
  const domPath = await assertDiskAttachTarget(name, slot);
  const sizeG = Math.max(1, parseInt(sizeGB, 10) || 32);
  const diskPath = await reserveNewDiskFile(getVMBasePath(name));
  try {
    await execFile('qemu-img', ['create', '-f', 'qcow2', diskPath, `${sizeG}G`], { timeout: 20_000 }); // sparse: seconds at most (CODING-RULES §6)
    await defineWithNewDisk(domPath, name, slot, diskPath, bus, 'qcow2');
  } catch (err) {
    /* The file is ours (reserved above) and not referenced by the domain — remove it. */
    await unlink(diskPath).catch(() => { /* already gone; nothing else to undo */ });
    throw err;
  }
}

export async function detachDisk(name, slot) {
  const domPath = await resolveDomain(name);
  const state = await getDomainState(domPath);
  if (!isShutOff(state.code)) {
    throw vmError('VM_MUST_BE_OFFLINE', `VM "${name}" must be stopped to detach disks`);
  }

  await redefineVM(domPath, (dom) => {
    const disks = dom.devices ? diskList(dom) : [];
    const filtered = disks.filter((d) => !d.target || d.target['@_dev'] !== slot);
    if (filtered.length === disks.length) {
      throw vmError('DISK_NOT_FOUND', `No disk found at slot ${slot}`);
    }
    dom.devices.disk = filtered;
  }, {
    defineError: (err) => vmError('LIBVIRT_ERROR', `Failed to detach disk ${slot}`, err.message),
  });
}

export async function resizeDiskBySlot(name, slot, sizeGB) {
  const domPath = await resolveDomain(name);
  const state = await getDomainState(domPath);
  if (!isShutOff(state.code)) {
    throw vmError('VM_MUST_BE_OFFLINE', `VM "${name}" must be stopped to resize disks`);
  }

  const xml = await getDomainXML(domPath);
  const config = parseVMFromXML(xml);
  const disk = config?.disks?.find(d => d.slot === slot && d.device === 'disk');
  if (!disk || !disk.source) {
    throw vmError('DISK_NOT_FOUND', `No disk found at slot ${slot}`);
  }

  // No <driver type> means raw to libvirt; resize it as that.
  return resizeDiskImage(disk.source, sizeGB, { format: disk.driverType || 'raw' });
}
