/**
 * Cloud-init: generate ISO, attach/detach sde, get/update config.
 * XML handled via fast-xml-parser (parse/build), not regex.
 */
import { join } from 'node:path';
import { connectionState, resolveDomain, getDomainState, getDomainXML, getDomainObjAndIface, vmError } from './vmManagerConnection.js';
import { extractDiskSnippet } from './vmManagerDisk.js';
import { parseDomainRaw, buildXml, buildDiskXml, parseVMFromXML } from './vmManagerXml.js';
import { getVMBasePath } from '../../paths.js';
import {
  generateCloudInitISO,
  deleteCloudInitISO,
  saveCloudInitConfig,
  loadCloudInitConfig,
  deleteCloudInitConfig,
} from '../../cloudInit.js';

export async function generateCloudInit(vmName, config) {
  let firstNicMac;
  try {
    const domPath = await resolveDomain(vmName);
    const xml = await getDomainXML(domPath);
    const vm = parseVMFromXML(xml);
    firstNicMac = vm?.nics?.[0]?.mac ?? undefined;
  } catch {
    /* VM missing or XML unreadable — cloud-init can still run without MAC hint */
    firstNicMac = undefined;
  }

  // Carry the prior hashed password forward when the caller passes the `***`
  // placeholder (UI's "leave password unchanged"). Without this we used to
  // silently re-hash the literal `***` string and downgrade the VM password.
  const prior = await loadCloudInitConfig(vmName);
  const priorPasswordHash = prior?.passwordHash || '';

  const { isoPath, passwordHash } = await generateCloudInitISO(vmName, config, {
    firstNicMac,
    priorPasswordHash,
  });

  const stored = {
    ...config,
    enabled: true,
    password: passwordHash ? '***' : '',
    passwordHash: passwordHash || '',
  };
  await saveCloudInitConfig(vmName, stored);
  return isoPath;
}

/**
 * Detach/eject sde and remove cloud-init ISO. Does not delete cloud-init.json.
 */
async function detachCloudInitFromDomainAndRemoveIso(vmName) {
  const domPath = await resolveDomain(vmName);
  const state = await getDomainState(domPath);
  const fullXml = await getDomainXML(domPath);
  const disk = extractDiskSnippet(fullXml, 'sde');

  if (disk) {
    const { iface } = await getDomainObjAndIface(domPath);
    const isRunning = state.code === 1 || state.code === 2;

    delete disk.source;
    const flags = isRunning ? 3 : 2;
    try {
      await iface.UpdateDevice(buildDiskXml(disk), flags);
    } catch {
      /* eject may fail for running VM; offline path below removes device from XML */
    }

    if (!isRunning) {
      const parsed = parseDomainRaw(fullXml);
      const dom = parsed?.domain;
      if (dom?.devices?.disk) {
        const disks = Array.isArray(dom.devices.disk) ? dom.devices.disk : [dom.devices.disk];
        const filtered = disks.filter((d) => !d.target || d.target['@_dev'] !== 'sde');
        dom.devices.disk = filtered.length === 1 ? filtered[0] : filtered;
        try {
          await connectionState.connectIface.DomainDefineXML(buildXml(parsed));
        } catch {
          /* best-effort define after detach — disk already cleared from XML intent */
        }
      }
    }
  }

  await deleteCloudInitISO(vmName);
}

function mergeCloudInitDisablePayload(existing, incoming) {
  const base = existing && typeof existing === 'object' ? { ...existing } : {};
  const { enabled: _en, password: incomingPassword, ...rest } = incoming;
  const merged = { ...base, ...rest, enabled: false };
  // `passwordHash` is internal — preserve from prior state, never accept from client.
  merged.passwordHash = base.passwordHash || '';
  const isPlaceholder = incomingPassword === '***' || incomingPassword === 'set';
  if (incomingPassword && !isPlaceholder && String(incomingPassword).trim() !== '') {
    // A new plaintext password came in even though we're disabling — store
    // the placeholder; the hash will be regenerated when cloud-init is
    // re-enabled.
    merged.password = '***';
  } else if (base.password !== undefined && base.password !== '') {
    merged.password = base.password;
  } else if (merged.passwordHash) {
    merged.password = '***';
  } else {
    merged.password = '';
  }
  return merged;
}

export async function attachCloudInitDisk(vmName) {
  const vmBasePath = getVMBasePath(vmName);
  const isoPath = join(vmBasePath, 'cloud-init.iso');

  const domPath = await resolveDomain(vmName);
  const state = await getDomainState(domPath);
  const { iface } = await getDomainObjAndIface(domPath);
  const isRunning = state.code === 1 || state.code === 2;

  const fullXml = await getDomainXML(domPath);
  const existingDisk = extractDiskSnippet(fullXml, 'sde');

  if (existingDisk) {
    existingDisk['@_type'] = 'file';
    existingDisk.source = { '@_file': isoPath };
    const flags = isRunning ? 3 : 2;
    try {
      await iface.UpdateDevice(buildDiskXml(existingDisk), flags);
    } catch (err) {
      throw vmError('LIBVIRT_ERROR', `Failed to attach cloud-init disk to sde`, err.message);
    }
  } else {
    const newDisk = {
      '@_type': 'file',
      '@_device': 'cdrom',
      driver: { '@_name': 'qemu', '@_type': 'raw' },
      source: { '@_file': isoPath },
      target: { '@_dev': 'sde', '@_bus': 'sata' },
      readonly: {},
    };
    if (isRunning) {
      try {
        await iface.AttachDevice(buildDiskXml(newDisk), 3);
      } catch (err) {
        throw vmError('LIBVIRT_ERROR', `Failed to attach cloud-init disk`, err.message);
      }
    } else {
      const parsed = parseDomainRaw(fullXml);
      const dom = parsed?.domain;
      if (!dom?.devices) throw vmError('PARSE_ERROR', 'Invalid domain XML');
      const disks = Array.isArray(dom.devices.disk) ? dom.devices.disk : [dom.devices.disk];
      dom.devices.disk = [...disks, newDisk];
      try {
        await connectionState.connectIface.DomainDefineXML(buildXml(parsed));
      } catch (err) {
        throw vmError('LIBVIRT_ERROR', `Failed to attach cloud-init disk`, err.message);
      }
    }
  }
}

export async function detachCloudInitDisk(vmName) {
  await detachCloudInitFromDomainAndRemoveIso(vmName);
  await deleteCloudInitConfig(vmName);
}

export async function getCloudInitConfig(vmName) {
  const config = await loadCloudInitConfig(vmName);
  if (!config) return null;
  // Internal-only fields (passwordHash) must not flow back to the client.
  const { passwordHash: _hash, ...safe } = config;
  const hasPassword = Boolean(safe.password) || Boolean(_hash);
  return {
    ...safe,
    enabled: safe.enabled !== false,
    password: hasPassword ? 'set' : '',
    sshKey: safe.sshKey || '',
  };
}

export async function updateCloudInit(vmName, config) {
  if (config.enabled === false) {
    const existing = await loadCloudInitConfig(vmName);
    const merged = mergeCloudInitDisablePayload(existing, config);
    await detachCloudInitFromDomainAndRemoveIso(vmName);
    await saveCloudInitConfig(vmName, merged);
    return;
  }

  await generateCloudInit(vmName, config);
  try {
    await attachCloudInitDisk(vmName);
  } catch (err) {
    /* ISO regenerated; live attach can fail if VM state disallows it — config still saved */
    console.warn(`[vmManager] Could not hot-swap cloud-init disk for "${vmName}":`, err.message);
  }
}
