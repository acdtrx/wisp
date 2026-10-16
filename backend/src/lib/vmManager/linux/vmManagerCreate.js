/**
 * VM create, delete; domain XML building and template helpers.
 */
import { mkdir, rm, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

import dbus from 'dbus-next';

import { connectionState, resolveDomain, getDomainState, getDomainXML, getDomainObjAndIface, vmError, generateMAC } from './vmManagerConnection.js';
import { parseDomainRaw, buildXml } from './vmManagerXml.js';
import { validateVMName } from './vmManagerValidation.js';
import { getVMBasePath, getVmsPath } from './vmManagerPaths.js';
import { resizeDisk as resizeDiskImage, copyAndConvert, getDiskInfo } from '../../storage/index.js';
import { listHostFirmware } from './vmManagerHost.js';
import { getDefaultBridge } from '../../networking/index.js';
import { refreshVMListCache } from './vmManagerList.js';
import { isOfflineState } from './libvirtConstants.js';

const execFile = promisify(execFileCb);

const TEMPLATE_DEFAULTS = {
  'ubuntu-server': {
    osType: 'Linux',
    osVariant: 'ubuntu24.04',
    firmware: 'uefi',
    machineType: 'q35',
    cloudInit: { enabled: true, hostname: '', username: 'wisp', growPartition: true, packageUpgrade: true, installQemuGuestAgent: true, installAvahiDaemon: true },
  },
  'ubuntu-desktop': {
    osType: 'Linux',
    osVariant: 'ubuntu24.04',
    firmware: 'uefi',
    machineType: 'q35',
    cloudInit: { enabled: true, hostname: '', username: 'wisp', growPartition: true, packageUpgrade: true, installQemuGuestAgent: true, installAvahiDaemon: true },
  },
  'windows-11': {
    osType: 'Windows',
    osVariant: 'win11',
    firmware: 'uefi-secure',
    machineType: 'q35',
    vtpm: true,
    windowsOptimisations: true,
    cloudInit: null,
  },
  'custom': {},
};

function applyTemplateDefaults(spec) {
  const template = (spec.template || 'custom').toLowerCase().replace(/\s+/g, '-');
  const defaults = TEMPLATE_DEFAULTS[template] || TEMPLATE_DEFAULTS.custom;
  const merged = { ...defaults, ...spec, name: spec.name };
  if (merged.osType === 'Windows' && merged.vtpm !== false) {
    merged.vtpm = true;
  }
  return merged;
}

function pickUEFIFirmware(firmwareList, secureBoot) {
  const codePath = firmwareList.find(p => {
    const base = p.split('/').pop().toLowerCase();
    return base.includes('code') && (secureBoot ? base.includes('sec') : !base.includes('vars'));
  }) || firmwareList.find(p => p.toLowerCase().includes('code'));
  const varsPath = firmwareList.find(p => {
    const base = p.split('/').pop().toLowerCase();
    return base.includes('var') && !base.includes('code');
  });
  return { loader: codePath, nvram: varsPath };
}

/** Returns fast-xml-parser-compatible features object for Windows VMs. */
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

/** Returns fast-xml-parser-compatible clock object for Windows VMs. */
export function getWindowsClock() {
  return {
    '@_offset': 'localtime',
    timer: { '@_name': 'hypervclock', '@_present': 'yes' },
  };
}

/** Returns fast-xml-parser-compatible features object for Linux VMs (UEFI acpi). */
export function getLinuxFeatures() {
  return { acpi: {} };
}

/**
 * @param {object} spec
 * @param {{ path: string, bus: string }[]} blockDisks Up to two entries: first → sda, second → sdb in domain XML.
 * @param {string|null} cdrom1Path
 * @param {string|null} cdrom2Path
 * @param {string|null} sdePath
 * @param {{ loaderPath?: string|null, nvramPath?: string|null, defaultBridge?: string }} [opts]
 */
function buildDomainXML(spec, blockDisks, cdrom1Path, cdrom2Path, sdePath, { loaderPath = null, nvramPath = null, defaultBridge = 'virbr0' } = {}) {
  const name = spec.name;
  const uuid = randomUUID();
  const memoryKiB = (spec.memoryMiB || 1024) * 1024;
  const vcpus = Math.max(1, parseInt(spec.vcpus, 10) || 1);
  const cpuMode = spec.cpuMode || 'host-passthrough';
  const machine = (spec.machineType || 'q35').toLowerCase();
  const firmware = spec.firmware || 'bios';
  const isUEFI = firmware === 'uefi' || firmware === 'uefi-secure';
  const bootOrder = spec.bootOrder || ['hd', 'cdrom', 'network'];
  const bootMenu = spec.bootMenu !== false;
  const memBalloon = spec.memBalloon !== false;
  const guestAgent = spec.guestAgent !== false;
  const vtpm = !!spec.vtpm;
  const virtioRng = spec.virtioRng !== false;
  const nestedVirt = !!spec.nestedVirt;
  const videoDriver = spec.videoDriver || 'virtio';
  const graphicsType = spec.graphicsType || 'vnc';
  const nics = Array.isArray(spec.nics) && spec.nics.length > 0
    ? spec.nics
    : [{ type: 'bridge', source: defaultBridge, model: 'virtio', mac: generateMAC() }];

  const sdaEntry = blockDisks[0];
  const sdbEntry = blockDisks[1];
  const diskBus = sdaEntry?.bus || sdbEntry?.bus || (spec.disk && spec.disk.bus) || 'virtio';
  const sdbBus = sdbEntry?.bus || (spec.disk2 && spec.disk2.bus) || diskBus;

  const os = {
    type: { '@_arch': 'x86_64', '@_machine': machine, '#text': 'hvm' },
    boot: bootOrder.map(dev => ({ '@_dev': dev === 'hd' ? 'hd' : dev === 'cdrom' ? 'cdrom' : 'network' })),
  };
  if (bootMenu) os.bootmenu = { '@_enable': 'yes' };
  if (isUEFI) {
    os.loader = loaderPath
      ? { '@_readonly': 'yes', '@_type': 'pflash', '#text': loaderPath }
      : { '@_readonly': 'yes', '@_type': 'pflash' };
    os.nvram = nvramPath ? { '#text': nvramPath } : { '@_template': 'yes' };
  }

  let features = null;
  if (isUEFI) features = getLinuxFeatures();
  if (spec.windowsOptimisations || spec.osType === 'Windows') features = getWindowsFeatures();

  const cpu = {
    '@_mode': cpuMode,
    '@_check': 'none',
    '@_migratable': 'on',
    topology: { '@_sockets': '1', '@_dies': '1', '@_cores': String(vcpus), '@_threads': '1' },
  };
  if (nestedVirt) cpu.feature = [{ '@_policy': 'require', '@_name': 'vmx' }];

  const hasScsiController = diskBus === 'scsi' || sdbBus === 'scsi';
  const controllers = hasScsiController
    ? [{ '@_type': 'scsi', '@_model': 'virtio-scsi', '@_index': '0' }]
    : [];
  const disks = [];
  if (sdaEntry) {
    disks.push({
      '@_type': 'file',
      '@_device': 'disk',
      driver: { '@_name': 'qemu', '@_type': 'qcow2' },
      source: { '@_file': sdaEntry.path },
      target: { '@_dev': 'sda', '@_bus': diskBus },
    });
  }
  if (sdbEntry) {
    disks.push({
      '@_type': 'file',
      '@_device': 'disk',
      driver: { '@_name': 'qemu', '@_type': 'qcow2' },
      source: { '@_file': sdbEntry.path },
      target: { '@_dev': 'sdb', '@_bus': sdbBus },
    });
  }
  disks.push({
    '@_type': 'file',
    '@_device': 'cdrom',
    driver: { '@_name': 'qemu', '@_type': 'raw' },
    ...(cdrom1Path ? { source: { '@_file': cdrom1Path } } : {}),
    target: { '@_dev': 'sdc', '@_bus': 'sata' },
    readonly: {},
  });
  disks.push({
    '@_type': 'file',
    '@_device': 'cdrom',
    driver: { '@_name': 'qemu', '@_type': 'raw' },
    ...(cdrom2Path ? { source: { '@_file': cdrom2Path } } : {}),
    target: { '@_dev': 'sdd', '@_bus': 'sata' },
    readonly: {},
  });
  if (sdePath) {
    disks.push({
      '@_type': 'file',
      '@_device': 'cdrom',
      driver: { '@_name': 'qemu', '@_type': 'raw' },
      source: { '@_file': sdePath },
      target: { '@_dev': 'sde', '@_bus': 'sata' },
      readonly: {},
    });
  }

  const ifaces = nics.map((nic) => ({
    '@_type': nic.type || 'bridge',
    mac: { '@_address': nic.mac || generateMAC() },
    source: { '@_bridge': nic.source || defaultBridge },
    model: { '@_type': nic.model || 'virtio' },
  }));

  const devices = {
    ...(controllers.length ? { controller: controllers } : {}),
    disk: disks,
    interface: ifaces,
    graphics: [{ '@_type': graphicsType, '@_port': '-1', '@_autoport': 'yes', '@_listen': '127.0.0.1' }],
    video: [{ model: { '@_type': videoDriver } }],
    input: [{ '@_type': 'tablet', '@_bus': 'usb' }],
  };
  if (memBalloon) devices.memballoon = [{ '@_model': 'virtio' }];
  if (guestAgent) {
    devices.channel = [{ '@_type': 'unix', target: { '@_type': 'virtio', '@_name': 'org.qemu.guest_agent.0' } }];
  }
  if (vtpm) devices.tpm = [{ '@_model': 'tpm-tis', backend: { '@_type': 'emulator', '@_version': '2.0' } }];
  if (virtioRng) devices.rng = [{ '@_model': 'virtio', backend: { '@_model': 'random', '#text': '/dev/urandom' } }];

  const isWindows = spec.windowsOptimisations || spec.osType === 'Windows';

  const dom = {
    '@_type': 'kvm',
    name,
    uuid,
    memory: { '@_unit': 'KiB', '#text': String(memoryKiB) },
    ...(memBalloon ? { currentMemory: { '@_unit': 'KiB', '#text': String(memoryKiB) } } : {}),
    vcpu: { '@_placement': 'static', '#text': String(vcpus) },
    cpu,
    os,
    ...(features ? { features } : {}),
    ...(isWindows ? { clock: getWindowsClock() } : {}),
    devices,
  };
  dom.metadata = {
    'wisp:prefs': {
      '@_xmlns:wisp': 'https://wisp.local/app',
      'wisp:localDns': spec.localDns === false ? 'false' : 'true',
    },
  };

  return buildXml({ domain: dom });
}

/** Throws VM_EXISTS when libvirt already has a domain with this name. */
async function assertNoDomainNamed(name) {
  try {
    await connectionState.connectIface.DomainLookupByName(name);
  } catch {
    /* lookup failed — no domain by that name */
    return;
  }
  throw vmError('VM_EXISTS', `VM "${name}" already exists`);
}

function vmDirExistsError(name, dir) {
  return vmError(
    'VM_DIR_EXISTS',
    `A directory for VM "${name}" already exists at ${dir} — choose another name or remove the directory`,
  );
}

/**
 * Pre-flight for create / restore-as-new: the name must be free both in
 * libvirt and on disk. A leftover directory (e.g. from "delete VM, keep disks")
 * is refused, never written into — a new VM only ever owns files it created.
 * Callers that build artifacts before the manager runs use this to fail fast;
 * the operations themselves stay authoritative via createOwnVMDir.
 */
export async function assertVMNameAvailable(name) {
  if (!connectionState.connectIface) throw vmError('NO_CONNECTION', 'Not connected to libvirt');
  validateVMName(name);
  await assertNoDomainNamed(name);
  const dir = getVMBasePath(name);
  try {
    await lstat(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  throw vmDirExistsError(name, dir);
}

/**
 * Create a new VM's own directory, exclusively: an existing path (directory,
 * file or symlink) is VM_DIR_EXISTS, atomically, so a caller that gets the path
 * back knows it created the directory and may remove it on failure.
 */
export async function createOwnVMDir(name) {
  await mkdir(getVmsPath(), { recursive: true });
  const dir = getVMBasePath(name);
  try {
    await mkdir(dir);
  } catch (err) {
    if (err.code === 'EEXIST') throw vmDirExistsError(name, dir);
    throw err;
  }
  return dir;
}

/** Remove a directory this operation created (rollback). */
export async function removeOwnVMDir(dir) {
  await rm(dir, { recursive: true, force: true }).catch((err) => {
    /* rollback is best-effort — the original error is what the caller reports */
    connectionState.logger?.warn?.({ err: err.message, dir }, '[vmManager] Failed to remove VM directory on rollback');
  });
}

/**
 * Create and define a new VM. Refuses (VM_EXISTS / VM_DIR_EXISTS) when the name
 * is taken in libvirt or `<vmsPath>/<name>/` already exists; on any failure
 * after creating that directory, removes it.
 * @param {object} spec
 * @param {{ onStep?: (step: string, data?: object) => void, populateVMDir?: (vmDir: string) => Promise<void> }} [opts]
 *   populateVMDir: writes caller-owned files (e.g. the cloud-init seed ISO) into
 *   the freshly created VM directory before disks are provisioned; they share
 *   the directory's rollback.
 */
export async function createVM(spec, { onStep, populateVMDir } = {}) {
  const emit = (step, data) => { if (onStep) onStep(step, data); };
  if (!connectionState.connectIface) throw vmError('NO_CONNECTION', 'Not connected to libvirt');

  const s = applyTemplateDefaults(spec);
  const name = s.name;
  validateVMName(name);

  emit('validating');
  await assertNoDomainNamed(name);

  const disk = s.disk || {};
  const disk2 = s.disk2 || {};
  const primaryType = disk.type === undefined || disk.type === null ? 'new' : disk.type;
  if (primaryType === 'existing') {
    if (!disk.sourcePath) throw vmError('PARSE_ERROR', 'Existing image requires sourcePath');
  }
  if (disk2.type === 'existing') {
    if (!disk2.sourcePath) throw vmError('PARSE_ERROR', 'Existing image for second disk requires sourcePath');
  }

  const vmBasePath = await createOwnVMDir(name);
  try {
    await provisionAndDefineVM(s, vmBasePath, { emit, populateVMDir, primaryType, disk, disk2 });
  } catch (err) {
    // Everything under vmBasePath was written by this call (the dir was created
    // exclusively above), so removing it undoes the whole attempt.
    await removeOwnVMDir(vmBasePath);
    throw err;
  }

  if (s.autostart) {
    try {
      const path = await connectionState.connectIface.DomainLookupByName(name);
      const obj = await connectionState.bus.getProxyObject('org.libvirt', path);
      const props = obj.getInterface('org.freedesktop.DBus.Properties');
      await props.Set('org.libvirt.Domain', 'Autostart', new dbus.Variant('b', true));
    } catch (err) {
      /* VM defined; autostart failure is non-fatal */
      connectionState.logger?.warn?.({ err: err.message, vm: name }, '[vmManager] Failed to set autostart');
    }
  }

  refreshVMListCache();
  // No `done` step here: the caller's job completion emits the terminal `done`.
  return { name };
}

/**
 * createVM body after the VM directory exists: caller files, disks, domain XML,
 * define. Any throw leaves cleanup to createVM (it removes the whole directory).
 */
async function provisionAndDefineVM(s, vmBasePath, { emit, populateVMDir, primaryType, disk, disk2 }) {
  const name = s.name;

  // Caller-supplied files (e.g. a cloud-init seed ISO) are written into the
  // fresh directory before anything else, inside the same rollback scope.
  if (populateVMDir) await populateVMDir(vmBasePath);

  /* cdrom1Path / cdrom2Path are caller-provided absolute paths — the route
     resolves library-relative input and runs the security check before
     reaching vmManager. */
  const cdrom1Path = s.cdrom1Path || null;
  const cdrom2Path = s.cdrom2Path || null;

  /** Ordered non-none disk specs; first file is disk0.qcow2 → sda, second is disk1.qcow2 → sdb. */
  const physicalSpecs = [];
  if (primaryType && primaryType !== 'none') physicalSpecs.push(disk);
  if (disk2.type && disk2.type !== 'none') physicalSpecs.push(disk2);

  for (let i = 0; i < physicalSpecs.length; i++) {
    const dspec = physicalSpecs[i];
    const destPath = join(vmBasePath, `disk${i}.qcow2`);
    if (dspec.type === 'existing') {
      /* sourcePath is caller-provided absolute (route resolved + validated). */
      const src = dspec.sourcePath;
      emit('copying', { percent: 0 });
      await copyAndConvert(src, destPath, (pct) => emit('copying', { percent: pct }));
      if (dspec.resizeGB != null && dspec.resizeGB > 0) {
        emit('resizing');
        const info = await getDiskInfo(destPath);
        const currentGB = info.virtualSize / (1024 ** 3);
        if (dspec.resizeGB > currentGB) {
          await resizeDiskImage(destPath, dspec.resizeGB);
        }
      }
    } else {
      emit('creating-disk');
      const sizeGB = Math.max(1, parseInt(dspec.sizeGB, 10) || 32);
      await execFile('qemu-img', ['create', '-f', 'qcow2', destPath, `${sizeGB}G`]);
    }
  }

  const blockDisksForXml = physicalSpecs.map((dspec, i) => ({
    path: join(vmBasePath, `disk${i}.qcow2`),
    bus: dspec.bus || 'virtio',
  }));

  // The cloud-init ISO is built by the caller (Wisp glue) through populateVMDir.
  // We just record the expected path so buildDomainXML can wire up the sde slot.
  let sdePath = null;
  const osCategory = s.osType === 'Windows' ? 'windows' : 'linux';
  if (s.cloudInit && osCategory !== 'windows' && s.cloudInit.enabled !== false) {
    emit('cloudinit');
    sdePath = join(vmBasePath, 'cloud-init.iso');
  }

  emit('defining');
  let loaderPath = null;
  let nvramPath = null;
  if (s.firmware === 'uefi' || s.firmware === 'uefi-secure') {
    const fwList = await listHostFirmware();
    if (fwList.length > 0) {
      const fw = pickUEFIFirmware(fwList, s.firmware === 'uefi-secure');
      if (fw.loader) {
        loaderPath = fw.loader;
        nvramPath = join(vmBasePath, 'VARS.fd');
      }
    }
  }
  const defaultBridge = await getDefaultBridge();
  const xml = buildDomainXML(s, blockDisksForXml, cdrom1Path, cdrom2Path, sdePath, { loaderPath, nvramPath, defaultBridge });

  if (!connectionState.connectIface) throw vmError('NO_CONNECTION', 'Not connected to libvirt');
  try {
    await connectionState.connectIface.DomainDefineXML(xml);
  } catch (err) {
    throw vmError('LIBVIRT_ERROR', `Failed to define VM "${name}"`, err.message);
  }
}

// libvirt VIR_DOMAIN_UNDEFINE_* flags (virDomainUndefineFlagsValues in
// libvirt-domain.h), declared inline since this is the only call site.
const VIR_DOMAIN_UNDEFINE_SNAPSHOTS_METADATA = 0x2;
const VIR_DOMAIN_UNDEFINE_NVRAM = 0x4;
const VIR_DOMAIN_UNDEFINE_KEEP_NVRAM = 0x8;

export async function deleteVM(name, deleteDisks = false) {
  const path = await resolveDomain(name);
  const state = await getDomainState(path);
  const { iface } = await getDomainObjAndIface(path);

  if (!isOfflineState(state.code)) {
    try {
      await iface.Destroy(0);
    } catch {
      /* may already be stopped */
    }
  }

  // Detect UEFI before undefine so we can pass the right flag (otherwise
  // Undefine refuses on a domain with managed NVRAM). Also note where the
  // NVRAM file actually lives — if it's outside this VM's per-VM directory
  // (legacy state from a pre-fix rename, or a domain defined outside Wisp), we must NOT
  // pass VIR_DOMAIN_UNDEFINE_NVRAM since libvirt would delete a file that
  // may belong to another VM.
  let hasNvram = false;
  let nvramFile = null;
  try {
    const xml = await getDomainXML(path);
    const parsed = parseDomainRaw(xml);
    const dom = parsed?.domain;
    const loaderNode = dom?.os?.loader;
    const nvramNode = dom?.os?.nvram;
    hasNvram = !!nvramNode ||
      (typeof loaderNode === 'object' && loaderNode['@_type'] === 'pflash');
    if (typeof nvramNode === 'string') nvramFile = nvramNode.trim();
    else if (nvramNode && typeof nvramNode === 'object' && typeof nvramNode['#text'] === 'string') {
      nvramFile = nvramNode['#text'].trim();
    }
  } catch {
    /* proceed with default flag if XML read fails */
  }
  const ownVmDir = getVMBasePath(name);
  const nvramInOwnDir = nvramFile && (nvramFile === join(ownVmDir, 'VARS.fd') || nvramFile.startsWith(`${ownVmDir}/`));

  // Symmetric on-disk semantics:
  //   deleteDisks=true  → tell libvirt to remove its managed NVRAM, then
  //                       rm -rf the per-VM dir at the end. Everything goes.
  //   deleteDisks=false → KEEP_NVRAM and leave the per-VM dir untouched.
  //                       Operator picked "keep my data" — that means disks,
  //                       NVRAM, cloud-init.iso, cloud-init.json all stay.
  // Wisp has no snapshot feature, but a VM can carry libvirt snapshot
  // metadata made outside it (e.g. `virsh snapshot-create`), which makes a
  // plain Undefine refuse; SNAPSHOTS_METADATA drops that metadata with the
  // domain. Snapshot data inside the disk images goes (or stays) with them.
  let undefineFlags = VIR_DOMAIN_UNDEFINE_SNAPSHOTS_METADATA;
  if (hasNvram) {
    // Only let libvirt delete the NVRAM file when it lives inside this VM's
    // own directory. Otherwise (legacy mismatch, a file shared with another
    // domain, etc.) keep it — deleting could corrupt another VM.
    const safeToDeleteNvram = deleteDisks && nvramInOwnDir;
    undefineFlags |= safeToDeleteNvram ? VIR_DOMAIN_UNDEFINE_NVRAM : VIR_DOMAIN_UNDEFINE_KEEP_NVRAM;
  }

  try {
    await iface.Undefine(undefineFlags);
  } catch (err) {
    throw vmError('LIBVIRT_ERROR', `Failed to delete VM "${name}"`, err.message);
  }

  if (deleteDisks) {
    const vmBasePath = getVMBasePath(name);
    await rm(vmBasePath, { recursive: true, force: true }).catch(() => {
      /* VM dir may be partially gone */
    });
  }

  connectionState.vmStartTimes.delete(path);
  connectionState.prevVMStats.delete(path);
  refreshVMListCache();
}
