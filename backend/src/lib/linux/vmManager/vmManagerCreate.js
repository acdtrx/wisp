/**
 * VM create, delete, clone; domain XML building and template helpers.
 */
import { copyFile, unlink, mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

import dbus from 'dbus-next';

import { connectionState, resolveDomain, getDomainState, getDomainXML, getDomainObjAndIface, vmError, generateMAC } from './vmManagerConnection.js';
import { parseVMFromXML, parseDomainRaw, buildXml } from './vmManagerXml.js';
import { validateVMName } from './vmManagerValidation.js';
import { getVMBasePath } from './vmManagerPaths.js';
import { resizeDisk as resizeDiskImage, copyAndConvert, getDiskInfo } from '../../storage/index.js';
import { listHostFirmware } from './vmManagerHost.js';
import { getDefaultBridge } from '../../networking/index.js';
import { listSnapshots, deleteSnapshot } from './vmManagerSnapshots.js';
import { refreshVMListCache } from './vmManagerList.js';

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

function normalizeNicVlan(nic, index) {
  if (nic?.vlan == null || nic.vlan === '') return null;
  throw vmError(
    'CONFIG_ERROR',
    `NIC ${index + 1}: VLAN tagging is not supported for VM bridge interfaces on this host. Use a VLAN-specific bridge instead (for example br0.22).`
  );
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

  const ifaces = nics.map((nic, index) => {
    const vlan = normalizeNicVlan(nic, index);
    const iface = {
      '@_type': nic.type || 'bridge',
      mac: { '@_address': nic.mac || generateMAC() },
      source: { '@_bridge': nic.source || defaultBridge },
      model: { '@_type': nic.model || 'virtio' },
    };
    if (vlan != null) iface.vlan = { tag: { '@_id': String(vlan) } };
    return iface;
  });

  const devices = {
    ...(controllers.length ? { controller: controllers } : {}),
    disk: disks,
    interface: ifaces,
    graphics: [{ '@_type': graphicsType, '@_port': '-1', '@_autoport': 'yes', '@_listen': '0.0.0.0' }],
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

export async function createVM(spec, { onStep } = {}) {
  const emit = (step, data) => { if (onStep) onStep(step, data); };
  if (!connectionState.connectIface) throw vmError('NO_CONNECTION', 'Not connected to libvirt');

  const s = applyTemplateDefaults(spec);
  const name = (s.name || '').trim();
  if (!name) throw vmError('PARSE_ERROR', 'VM name is required');
  validateVMName(name);

  emit('validating');
  try {
    await connectionState.connectIface.DomainLookupByName(name);
    throw vmError('VM_EXISTS', `VM "${name}" already exists`);
  } catch (err) {
    if (err.code === 'VM_EXISTS') throw err;
  }

  const disk = s.disk || {};
  const disk2 = s.disk2 || {};
  const primaryType = disk.type === undefined || disk.type === null ? 'new' : disk.type;
  if (primaryType === 'existing') {
    if (!disk.sourcePath) throw vmError('PARSE_ERROR', 'Existing image requires sourcePath');
  }
  if (disk2.type === 'existing') {
    if (!disk2.sourcePath) throw vmError('PARSE_ERROR', 'Existing image for second disk requires sourcePath');
  }

  const vmBasePath = getVMBasePath(name);
  await mkdir(vmBasePath, { recursive: true });

  /* cdrom1Path / cdrom2Path are caller-provided absolute paths — the route
     resolves library-relative input and runs the security check before
     reaching vmManager. */
  const cdrom1Path = s.cdrom1Path || null;
  const cdrom2Path = s.cdrom2Path || null;

  /** Ordered non-none disk specs; first file is disk0.qcow2 → sda, second is disk1.qcow2 → sdb. */
  const physicalSpecs = [];
  if (primaryType && primaryType !== 'none') physicalSpecs.push(disk);
  if (disk2.type && disk2.type !== 'none') physicalSpecs.push(disk2);

  const createdPaths = [];

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
    createdPaths.push(destPath);
  }

  const blockDisksForXml = physicalSpecs.map((dspec, i) => ({
    path: join(vmBasePath, `disk${i}.qcow2`),
    bus: dspec.bus || 'virtio',
  }));

  // Cloud-init ISO/JSON are built by the route layer (Wisp glue) before createVM is
  // called. We just record the expected path so buildDomainXML can wire up the sde
  // slot. Caller must ensure the ISO already exists at this path when cloudInit is
  // requested for non-Windows guests.
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

  if (connectionState.connectIface) {
    try {
      await connectionState.connectIface.DomainDefineXML(xml);
    } catch (err) {
      for (const p of createdPaths) {
        await unlink(p).catch(() => {
          /* rollback — file may not exist */
        });
      }
      // Cloud-init ISO cleanup on rollback is the route's responsibility — see
      // POST /vms in routes/vms.js, which catches this throw and runs the cleanup.
      throw vmError('LIBVIRT_ERROR', `Failed to define VM "${name}"`, err.message);
    }
  }

  if (s.autostart && connectionState.connectIface) {
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
  emit('done', { name });
  return { name };
}

export async function cloneVM(name, newName) {
  if (!connectionState.connectIface) throw vmError('NO_CONNECTION', 'Not connected to libvirt');
  validateVMName(newName);

  const path = await resolveDomain(name);
  const state = await getDomainState(path);
  if (state.code === 1) throw vmError('VM_RUNNING', `Stop VM "${name}" before cloning`);

  try {
    await connectionState.connectIface.DomainLookupByName(newName);
    throw vmError('VM_EXISTS', `VM "${newName}" already exists`);
  } catch (err) {
    if (err.code === 'VM_EXISTS') throw err;
  }

  const xml = await getDomainXML(path);
  const config = parseVMFromXML(xml);
  if (!config) throw vmError('PARSE_ERROR', `Failed to parse XML for VM "${name}"`);

  // Copy disks into the new VM's own directory so a future deleteVM(newName)
  // / renameVM(newName) doesn't have to chase files that live under the
  // source VM's path. Keeps the "directory == VM name" invariant.
  const newVmDir = getVMBasePath(newName);
  await mkdir(newVmDir, { recursive: true });

  const diskMapping = [];
  let dirCleanupNeeded = true;
  try {
    for (const disk of config.disks) {
      if (disk.device !== 'disk' || !disk.source) continue;

      // Use the source's basename (e.g. disk0.qcow2) inside newVmDir so the
      // cloned VM has the same on-disk layout as a freshly-created VM.
      const baseName = disk.source.slice(disk.source.lastIndexOf('/') + 1);
      const newDiskPath = join(newVmDir, baseName);

      try {
        await execFile('cp', ['--reflink=auto', disk.source, newDiskPath]);
      } catch {
        /* cp --reflink not supported — full copy */
        await copyFile(disk.source, newDiskPath);
      }
      diskMapping.push({ oldPath: disk.source, newPath: newDiskPath });
    }

    const parsed = parseDomainRaw(xml);
    const dom = parsed.domain;
    dom.name = newName;
    delete dom.uuid;
    for (const d of dom.devices?.disk || []) {
      const file = d.source?.['@_file'];
      if (file) {
        const mapping = diskMapping.find(m => m.oldPath === file);
        if (mapping) d.source['@_file'] = mapping.newPath;
      }
    }
    // NVRAM (UEFI): always relocate the clone's NVRAM into its own dir so
    // it never shares the file with the source. Two cases:
    //   - Source NVRAM file exists on disk: copy it (boot vars, secure-boot
    //     enrolled keys, etc. carry forward).
    //   - Source NVRAM declared in XML but missing on disk (rare): leave the
    //     copy out; libvirt will template-fill on first define.
    // Either way, rewrite the XML to point at <newVmDir>/VARS.fd so a future
    // deleteVM(newName, deleteDisks=true) only ever touches the clone's files.
    const os = dom.os;
    if (os) {
      const nvramSrc = typeof os.nvram === 'string'
        ? os.nvram
        : (os.nvram && typeof os.nvram === 'object' && typeof os.nvram['#text'] === 'string' ? os.nvram['#text'] : null);
      if (nvramSrc) {
        const newNvramPath = join(newVmDir, 'VARS.fd');
        try {
          await copyFile(nvramSrc, newNvramPath);
        } catch (err) {
          if (!err || err.code !== 'ENOENT') throw err;
          /* source NVRAM missing — let libvirt template-fill on define */
        }
        if (typeof os.nvram === 'string') {
          os.nvram = newNvramPath;
        } else if (os.nvram && typeof os.nvram === 'object') {
          os.nvram['#text'] = newNvramPath;
        }
      }
    }
    for (const iface of dom.devices?.interface || []) {
      iface.mac = { '@_address': generateMAC() };
    }
    const newXml = buildXml(parsed);

    await connectionState.connectIface.DomainDefineXML(newXml);
    dirCleanupNeeded = false;
  } catch (err) {
    if (dirCleanupNeeded) {
      // Roll back: delete copied disks AND the newly-created dir so a retry
      // doesn't trip over leftover state.
      for (const { newPath } of diskMapping) {
        await unlink(newPath).catch(() => {
          /* may already be gone */
        });
      }
      await rm(newVmDir, { recursive: true, force: true }).catch(() => {
        /* best-effort */
      });
    }
    if (err && err.code) throw err;
    throw vmError('CLONE_FAILED', `Failed to define cloned VM "${newName}"`, err.message);
  }
  refreshVMListCache();
}

// libvirt VIR_DOMAIN_UNDEFINE_* flags — declared inline since this is the
// only call site that needs them. Bit positions match libvirt-domain.h's
// virDomainUndefineFlagsValues enum (1 << 2 / 1 << 3). Earlier values of
// 0x2 / 0x4 happened to be SNAPSHOTS_METADATA / NVRAM respectively, which
// is why deleteVM on a UEFI domain failed with libvirt error
// "cannot undefine domain with nvram" — the wrong flag was being set.
const VIR_DOMAIN_UNDEFINE_NVRAM = 0x4;
const VIR_DOMAIN_UNDEFINE_KEEP_NVRAM = 0x8;

export async function deleteVM(name, deleteDisks = false) {
  const path = await resolveDomain(name);
  const state = await getDomainState(path);
  const { iface } = await getDomainObjAndIface(path);

  if (state.code !== 5 && state.code !== 0) {
    try {
      await iface.Destroy(0);
    } catch {
      /* may already be stopped */
    }
  }

  // Detect UEFI before undefine so we can pass the right flag (otherwise
  // Undefine refuses on a domain with managed NVRAM). Also note where the
  // NVRAM file actually lives — if it's outside this VM's per-VM directory
  // (legacy state from a pre-fix rename, or a mis-cloned VM), we must NOT
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

  // Snapshots block undefine; clear them up front (best-effort).
  try {
    const snapshots = await listSnapshots(name);
    for (const snap of snapshots) {
      try {
        await deleteSnapshot(name, snap.name);
      } catch (err) {
        connectionState.logger?.warn?.({ err: err.message, vm: name, snapshot: snap.name }, '[vmManager] Failed to delete snapshot before undefine');
      }
    }
  } catch {
    /* proceed with undefine even if listing snapshots fails */
  }

  // Symmetric on-disk semantics:
  //   deleteDisks=true  → tell libvirt to remove its managed NVRAM, then
  //                       rm -rf the per-VM dir at the end. Everything goes.
  //   deleteDisks=false → KEEP_NVRAM and leave the per-VM dir untouched.
  //                       Operator picked "keep my data" — that means disks,
  //                       NVRAM, cloud-init.iso, cloud-init.json all stay.
  let undefineFlags = 0;
  if (hasNvram) {
    // Only let libvirt delete the NVRAM file when it lives inside this VM's
    // own directory. Otherwise (legacy mismatch, shared file from a buggy
    // pre-fix clone, etc.) keep it — deleting could corrupt another VM.
    const safeToDeleteNvram = deleteDisks && nvramInOwnDir;
    undefineFlags = safeToDeleteNvram ? VIR_DOMAIN_UNDEFINE_NVRAM : VIR_DOMAIN_UNDEFINE_KEEP_NVRAM;
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

  connectionState.vmStartTimes.delete(name);
  connectionState.prevVMStats.delete(name);
  refreshVMListCache();
}
