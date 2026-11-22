/**
 * VM config update (Overview tab edits).
 * Uses fast-xml-parser parse/mutate/build instead of regex to avoid fragile XML handling.
 */
import { rmdir } from 'node:fs/promises';

import dbus from 'dbus-next';

import { validateVMName } from './vmManagerValidation.js';
import { getVMBasePath } from './vmManagerPaths.js';
import {
  connectionState, resolveDomain, domainExists, getDomainState, getDomainXML, getDomainObjAndIface, vmError,
} from './vmManagerConnection.js';
import { wrapVmError } from '../vmManagerShared.js';
import {
  parseVMFromXML, parseDomainRaw, setWispIcon, setWispPendingRestart, removeWispPref, domainDefinitionSignature,
  getWispProfile, setWispProfile, profileFromDefinition,
} from './vmManagerXml.js';
import { getWindowsFeatures, getWindowsClock, getLinuxFeatures, createOwnVMDir } from './vmManagerCreate.js';
import { moveVmDirectory, rewriteDomainPaths } from './vmManagerRename.js';
import { refreshVMListCache } from './vmManagerList.js';
import { redefineVM } from './vmManagerDefine.js';
import { isShutOff } from './libvirtConstants.js';
import {
  nicElement, videoElement, graphicsElement, memballoonElement, guestAgentChannelElement, isGuestAgentChannel,
  tpmElement, rngElement,
} from './vmManagerDevices.js';

export async function renameVM(name, newName) {
  if (!connectionState.connectIface) throw vmError('NO_CONNECTION', 'Not connected to libvirt');
  const domPath = await resolveDomain(name);
  if (newName === name) return { name };
  const state = await getDomainState(domPath);
  if (!isShutOff(state.code)) throw vmError('VM_MUST_BE_OFFLINE', `Stop VM "${name}" before renaming`);
  validateVMName(newName);
  if (await domainExists(newName)) throw vmError('VM_EXISTS', `VM "${newName}" already exists`);

  const oldDir = getVMBasePath(name);
  // Reserve the target name on disk: create its directory exclusively (an
  // existing path → 409 VM_DIR_EXISTS, atomically). A second rename to the same
  // name, or a create / restore-as-new racing this one, fails its own exclusive
  // mkdir instead of merging into this VM's files. The move below replaces the
  // reserved empty directory.
  const newDir = await createOwnVMDir(newName);
  // Drop the reservation when nothing moved into it (rmdir: never removes
  // files someone else put there).
  const releaseReservation = () => rmdir(newDir).catch((err) => {
    connectionState.logger?.warn?.({ err: err.message, dir: newDir }, '[vmManager] Failed to release a rename reservation');
  });
  const renameBack = async () => {
    try {
      const { iface } = await getDomainObjAndIface(domPath);
      await iface.Rename(name, 0);
    } catch (err) {
      connectionState.logger?.warn?.({ err: err.message, vm: newName }, '[vmManager] Failed to undo a libvirt rename');
    }
  };

  const { iface } = await getDomainObjAndIface(domPath);
  try {
    await iface.Rename(newName, 0);
  } catch (err) {
    await releaseReservation();
    throw vmError('LIBVIRT_ERROR', `Failed to rename VM "${name}"`, err.message);
  }

  let dirMoved;
  try {
    dirMoved = await moveVmDirectory(oldDir, newDir);
  } catch (moveErr) {
    await renameBack();
    await releaseReservation();
    throw moveErr;
  }
  // No directory to move (a VM with no files of its own): no directory under
  // the new name either.
  if (!dirMoved) {
    await releaseReservation();
  } else {
    try {
      await redefineVM(domPath, (dom) => rewriteDomainPaths(dom, oldDir, newDir) > 0);
    } catch (err) {
      try {
        await moveVmDirectory(newDir, oldDir);
      } catch (moveErr) {
        connectionState.logger?.warn?.({ err: moveErr.message, from: newDir, to: oldDir }, '[vmManager] Failed to move a VM directory back');
      }
      await renameBack();
      throw wrapVmError('LIBVIRT_ERROR', 'Failed to update domain XML after rename', err);
    }
  }
  refreshVMListCache();
  return { name: newName };
}

/**
 * Apply a partial configuration change to the VM's saved definition (every
 * field but its name, which renameVM changes). A VM that is on keeps running
 * what it started with: when the definition differs from it in anything but
 * Wisp's metadata, the restart-required flag is set in the same define.
 * Returns `{ ok, requiresRestart, name }`.
 */
export async function updateVMConfig(name, changes) {
  if (!connectionState.connectIface) throw vmError('NO_CONNECTION', 'Not connected to libvirt');
  const patch = changes && typeof changes === 'object' ? changes : {};
  const domPath = await resolveDomain(name);
  const state = await getDomainState(domPath);
  const isOn = !isShutOff(state.code);
  let requiresRestart = false;

  // The saved (inactive) definition is the baseline: on a VM that is on, the
  // live XML lacks earlier pending-restart edits, and defining from it would
  // revert them.
  await redefineVM(domPath, (dom, { xml, parsed }) => {
    const current = parseVMFromXML(xml);
    const baselineSignature = domainDefinitionSignature(parsed);
    applyConfigChanges(dom, current, patch);
    requiresRestart = isOn && domainDefinitionSignature(parsed) !== baselineSignature;
    if (requiresRestart) setWispPendingRestart(dom, new Date().toISOString());
  }, {
    defineError: (err) => vmError('LIBVIRT_ERROR', `Failed to update VM "${name}" configuration`, err.message),
  });
  /* The list carries the sizing, icon and the restart flag; libvirt's DEFINED
   * events are unreliable, so refresh it here as create and delete do. */
  refreshVMListCache();

  if (patch.autostart != null) {
    try {
      const { props } = await getDomainObjAndIface(domPath);
      await props.Set('org.libvirt.Domain', 'Autostart', new dbus.Variant('b', patch.autostart));
    } catch (err) {
      /* autostart is optional; domain XML update already succeeded */
      connectionState.logger?.warn?.({ err: err.message }, '[vmManager] Failed to set autostart');
    }
  }

  return { ok: true, requiresRestart, name };
}

/** Apply `patch` to the parsed `<domain>`; `current` is its parseVMFromXML reading. */
function applyConfigChanges(dom, current, patch) {
  if (patch.memoryMiB != null) {
    const kib = patch.memoryMiB * 1024;
    dom.memory = { '@_unit': 'KiB', '#text': String(kib) };
    if (dom.currentMemory) {
      dom.currentMemory = { '@_unit': 'KiB', '#text': String(kib) };
    }
  }

  const newVcpus = patch.vcpus != null ? parseInt(patch.vcpus, 10) : null;
  const newCpuMode = patch.cpuMode ?? null;
  const newNestedVirt = patch.nestedVirt ?? null;

  if (newVcpus != null || newCpuMode != null || newNestedVirt != null) {
    const vcpuCount = newVcpus || current.vcpus;
    const cpuMode = newCpuMode || current.cpuMode || 'host-passthrough';

    if (newVcpus != null) {
      dom.vcpu = { '@_placement': 'static', '#text': String(vcpuCount) };
    }

    const existingFeatures = current.cpuFeatures || [];
    const features = existingFeatures.filter((f) => f.name !== 'vmx' && f.name !== 'svm');
    if (newNestedVirt != null) {
      if (newNestedVirt) features.push({ name: 'vmx', policy: 'require' });
    } else if (current.nestedVirt) {
      features.push(...existingFeatures.filter((f) => f.name === 'vmx' || f.name === 'svm'));
    }

    const topology = { '@_sockets': '1', '@_dies': '1', '@_cores': String(vcpuCount), '@_threads': '1' };
    const featureObjs = features.map((f) => ({ '@_policy': f.policy, '@_name': f.name }));
    dom.cpu = {
      '@_mode': cpuMode,
      '@_check': 'none',
      '@_migratable': 'on',
      topology,
      feature: featureObjs.length ? featureObjs : undefined,
    };
  }

  if (patch.bootOrder != null && dom.os) {
    dom.os.boot = patch.bootOrder.map((dev) => ({ '@_dev': dev }));
  }

  if (patch.bootMenu != null && dom.os) {
    dom.os.bootmenu = { '@_enable': patch.bootMenu ? 'yes' : 'no' };
  }

  if (patch.osType != null) {
    dom.features = patch.osType === 'Windows' ? getWindowsFeatures() : getLinuxFeatures();
    if (patch.osType === 'Windows') {
      dom.clock = getWindowsClock();
    } else {
      delete dom.clock;
    }
  }

  if (patch.nics != null && dom.devices) {
    dom.devices.interface = patch.nics.map((nic) => nicElement(nic));
  }

  if (patch.videoDriver != null && dom.devices) {
    dom.devices.video = [videoElement(patch.videoDriver)];
  }

  if (patch.graphicsType != null && dom.devices) {
    dom.devices.graphics = [graphicsElement(patch.graphicsType)];
  }

  if (patch.memBalloon != null && dom.devices) {
    dom.devices.memballoon = [memballoonElement(patch.memBalloon)];
  }

  if (patch.guestAgent != null && dom.devices) {
    const channels = (dom.devices.channel || []).filter((ch) => !isGuestAgentChannel(ch));
    if (patch.guestAgent) channels.push(guestAgentChannelElement());
    if (channels.length) dom.devices.channel = channels;
    else delete dom.devices.channel;
  }

  if (patch.vtpm != null && dom.devices) {
    if (patch.vtpm) dom.devices.tpm = [tpmElement()];
    else delete dom.devices.tpm;
  }

  if (patch.virtioRng != null && dom.devices) {
    if (patch.virtioRng) dom.devices.rng = [rngElement()];
    else delete dom.devices.rng;
  }

  if (patch.iconId !== undefined) setWispIcon(dom, patch.iconId || null);
}

/**
 * Remove one Wisp pref (`wisp:<key>`) from the VM's saved definition, leaving
 * the rest of the XML as libvirt returned it: for a state migration retiring
 * a pref. Metadata only, so a running VM needs no restart. Defines only when
 * the pref is there, and never a transient domain (it stays as it is, not
 * changed). Returns `{ changed }`.
 */
export async function removeVMPref(name, key) {
  if (!connectionState.connectIface) throw vmError('NO_CONNECTION', 'Not connected to libvirt');
  const domPath = await resolveDomain(name);
  const changed = await redefineVM(domPath, (dom) => removeWispPref(dom, key), {
    skipTransient: true,
    defineError: (err) => vmError('LIBVIRT_ERROR', `Failed to remove the ${key} pref of VM "${name}"`, err.message),
  });
  return { changed };
}

/**
 * Give a VM defined before profiles the one its definition reads as
 * (`profileFromDefinition`), leaving the rest of the XML as libvirt returned it (read
 * with the secure flag, so a graphics password set outside Wisp survives): for a state
 * migration. Metadata only, so a running VM needs no restart. Defines only when the VM
 * has no profile, and never a transient domain, which a define would make persistent:
 * that one stays without a profile, not changed. Returns `{ changed, profile }`, the
 * profile stored or given, null for a transient domain left without one.
 */
export async function setMissingVMProfile(name) {
  if (!connectionState.connectIface) throw vmError('NO_CONNECTION', 'Not connected to libvirt');
  const domPath = await resolveDomain(name);
  let stored = null;
  let given = null;
  const changed = await redefineVM(domPath, (dom) => {
    stored = getWispProfile(dom);
    if (stored) return false;
    given = profileFromDefinition(dom);
    setWispProfile(dom, given);
    return true;
  }, {
    skipTransient: true,
    defineError: (err) => vmError('LIBVIRT_ERROR', `Failed to set the profile of VM "${name}"`, err.message),
  });
  return { changed, profile: changed ? given : stored };
}

/**
 * Every listen address in the parsed domain's `<graphics>` elements, as
 * `{ graphics, address, set(address) }`: the `listen` attribute and each
 * `<listen type='address' address='…'/>` child. Other listen types (network,
 * socket, none) carry no address of their own and are not listed.
 */
function graphicsListenRefs(dom) {
  const refs = [];
  for (const g of dom?.devices?.graphics || []) {
    if (!g || typeof g !== 'object') continue;
    const type = g['@_type'] || null;
    if (g['@_listen'] != null) {
      refs.push({ graphics: type, address: g['@_listen'], set: (a) => { g['@_listen'] = a; } });
    }
    const children = g.listen == null ? [] : (Array.isArray(g.listen) ? g.listen : [g.listen]);
    for (const l of children) {
      if (l && typeof l === 'object' && l['@_type'] === 'address' && l['@_address'] != null) {
        refs.push({ graphics: type, address: l['@_address'], set: (a) => { l['@_address'] = a; } });
      }
    }
  }
  return refs;
}

/**
 * Listen addresses of a VM's saved (inactive) graphics definition:
 * `[{ graphics: 'vnc'|'spice'|…, address }]`, one per `listen` attribute and
 * `<listen type='address'>` child.
 */
export async function getGraphicsListen(name) {
  if (!connectionState.connectIface) throw vmError('NO_CONNECTION', 'Not connected to libvirt');
  const domPath = await resolveDomain(name);
  const parsed = parseDomainRaw(await getDomainXML(domPath, { inactive: true }));
  if (!parsed.domain) throw vmError('PARSE_ERROR', 'Failed to parse domain XML');
  return graphicsListenRefs(parsed.domain).map(({ graphics, address }) => ({ graphics, address }));
}

/**
 * Point every listen address of the VM's saved graphics definition (see
 * getGraphicsListen) at `address`, leaving the rest of the XML as libvirt
 * returned it. Defines only when something differs, and never a transient
 * domain (left as it is, not changed). A running VM keeps its current
 * listener until its next start — the caller knows whether that needs
 * flagging. Returns `{ changed, previous }` (the distinct addresses replaced).
 */
export async function setGraphicsListen(name, address) {
  if (!connectionState.connectIface) throw vmError('NO_CONNECTION', 'Not connected to libvirt');
  if (typeof address !== 'string' || !address) throw vmError('CONFIG_ERROR', 'Listen address must be a non-empty string');
  const domPath = await resolveDomain(name);
  let previous = [];
  const changed = await redefineVM(domPath, (dom) => {
    const stale = graphicsListenRefs(dom).filter((r) => r.address !== address);
    if (stale.length === 0) return false;
    previous = [...new Set(stale.map((r) => r.address))];
    for (const r of stale) r.set(address);
    return true;
  }, {
    skipTransient: true,
    defineError: (err) => vmError('LIBVIRT_ERROR', `Failed to update the graphics listen address of VM "${name}"`, err.message),
  });
  return { changed, previous: changed ? previous : [] };
}
