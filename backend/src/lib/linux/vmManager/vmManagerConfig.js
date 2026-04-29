/**
 * VM config update (Overview tab edits).
 * Uses fast-xml-parser parse/mutate/build instead of regex to avoid fragile XML handling.
 */
import dbus from 'dbus-next';

import { validateVMName } from '../../validation.js';
import { getVMBasePath } from '../../paths.js';
import { getConfigSync } from '../../config.js';
import { connectionState, resolveDomain, getDomainState, getDomainXML, getDomainObjAndIface, vmError } from './vmManagerConnection.js';
import { parseVMFromXML, parseDomainRaw, buildXml, setWispMetadata } from './vmManagerXml.js';
import { getWindowsFeatures, getWindowsClock, getLinuxFeatures } from './vmManagerCreate.js';
import { publishVm, unpublishVm } from '../vmMdnsPublisher.js';
import { moveVmDirectory, rewriteDomainPaths, rewriteSnapshotMemoryPaths, findActualVmDir, pathExists } from './vmManagerRename.js';

/** Parsed `<name>` may be a string or `{ '#text': string }` from fast-xml-parser. */
function domainNameFromParsed(dom) {
  const n = dom?.name;
  if (n == null) return '';
  if (typeof n === 'object' && n['#text'] != null) return String(n['#text']).trim();
  return String(n).trim();
}

function normalizeNicVlan(nic, index) {
  if (nic?.vlan == null || nic.vlan === '') return null;
  throw vmError(
    'CONFIG_ERROR',
    `NIC ${index + 1}: VLAN tagging is not supported for VM bridge interfaces on this host. Use a VLAN-specific bridge instead (for example br0.22).`
  );
}

export async function updateVMConfig(name, changes) {
  if (!connectionState.connectIface) throw vmError('NO_CONNECTION', 'Not connected to libvirt');

  const patch = { ...(changes && typeof changes === 'object' ? changes : {}) };

  let domPath = await resolveDomain(name);
  const state = await getDomainState(domPath);
  const isRunning = state.code === 1 || state.code === 2 || state.code === 3;
  let xml = await getDomainXML(domPath);
  let parsed = parseDomainRaw(xml);
  let dom = parsed.domain;
  if (!dom) throw vmError('PARSE_ERROR', 'Failed to parse domain XML');
  let current = parseVMFromXML(xml);
  let requiresRestart = false;
  let effectiveName = name;

  if (patch.name != null) {
    const newName = typeof patch.name === 'string' ? patch.name.trim() : String(patch.name);
    const currentName = domainNameFromParsed(dom);
    if (newName !== currentName) {
      if (isRunning) {
        throw vmError('VM_MUST_BE_OFFLINE', `Stop VM "${name}" before renaming`);
      }
      validateVMName(newName);
      try {
        await connectionState.connectIface.DomainLookupByName(newName);
        throw vmError('VM_EXISTS', `VM "${newName}" already exists`);
      } catch (err) {
        if (err.code === 'VM_EXISTS') throw err;
      }

      // Where do this VM's files actually live? `getVMBasePath(currentName)`
      // is the *expected* dir, but legacy state from a pre-fix rename can
      // leave the files at a different path. Read the XML and find the
      // directory the disks/NVRAM actually reference.
      const expectedOldDir = getVMBasePath(currentName);
      const { vmsPath } = getConfigSync();
      const xmlBeforeRename = await getDomainXML(domPath);
      const parsedBeforeRename = parseDomainRaw(xmlBeforeRename);
      const inferredDir = findActualVmDir(parsedBeforeRename?.domain, vmsPath);
      // Prefer the expected dir when it both exists and matches inference.
      // When inference disagrees, trust inference (legacy convergence).
      // When no path lives under vmsPath at all (CDROM-only VMs), fall back
      // to whatever exists on disk; if neither exists it's a no-op move.
      let oldDir;
      if (inferredDir && inferredDir !== expectedOldDir) {
        oldDir = inferredDir;
      } else if (await pathExists(expectedOldDir)) {
        oldDir = expectedOldDir;
      } else if (inferredDir) {
        oldDir = inferredDir;
      } else {
        oldDir = expectedOldDir;
      }
      const newDir = getVMBasePath(newName);

      // The new dir must not already exist — collisions would mean we'd
      // overwrite or merge into an unrelated VM's files.
      if (await pathExists(newDir)) {
        throw vmError('CONFIG_ERROR', `Refusing to rename: target directory ${newDir} already exists`);
      }

      // 1. libvirt-level rename. Updates only the domain `<name>` element.
      const { iface } = await getDomainObjAndIface(domPath);
      try {
        await iface.Rename(newName, 0);
      } catch (err) {
        throw vmError('LIBVIRT_ERROR', `Failed to rename VM "${effectiveName}"`, err.message);
      }

      // 2. Move on-disk dir. If this fails, roll back the libvirt rename.
      let dirMoved = false;
      try {
        dirMoved = await moveVmDirectory(oldDir, newDir);
      } catch (moveErr) {
        try {
          const { iface: backIface } = await getDomainObjAndIface(await resolveDomain(newName));
          await backIface.Rename(currentName, 0);
        } catch { /* rollback best-effort; leave inconsistent state for the operator to inspect */ }
        throw moveErr;
      }

      effectiveName = newName;
      domPath = await resolveDomain(newName);
      xml = await getDomainXML(domPath);
      parsed = parseDomainRaw(xml);
      dom = parsed.domain;
      if (!dom) throw vmError('PARSE_ERROR', 'Failed to parse domain XML');

      // 3. Rewrite absolute paths in the domain XML to point at the new dir.
      //    Always attempt rewrite (using the inferred oldDir) — a successful
      //    move guarantees old paths are now invalid; even on a no-op move
      //    (rare CDROM-only case) the rewrite is harmless.
      if (dirMoved) {
        const rewritten = rewriteDomainPaths(dom, oldDir, newDir);
        if (rewritten > 0) {
          let outXml;
          try {
            outXml = buildXml(parsed);
            await connectionState.connectIface.DomainDefineXML(outXml);
          } catch (defErr) {
            // Roll back: move dir back, rename libvirt back.
            try { await moveVmDirectory(newDir, oldDir); } catch { /* best-effort */ }
            try {
              const { iface: backIface } = await getDomainObjAndIface(domPath);
              await backIface.Rename(currentName, 0);
            } catch { /* best-effort */ }
            throw vmError('LIBVIRT_ERROR', 'Failed to update domain XML after rename', defErr.message);
          }
          xml = await getDomainXML(domPath);
          parsed = parseDomainRaw(xml);
          dom = parsed.domain;
        }

        // 4. Rewrite snapshot memory file paths. Best-effort per snapshot —
        //    a missing/corrupt snapshot does not unwind the rename.
        await rewriteSnapshotMemoryPaths(domPath, oldDir, newDir, null);
      }

      current = parseVMFromXML(xml);
    }
    delete patch.name;
    if (Object.keys(patch).length === 0) {
      return { ok: true, requiresRestart: false };
    }
  }

  if (patch.memoryMiB != null) {
    const kib = patch.memoryMiB * 1024;
    dom.memory = { '@_unit': 'KiB', '#text': String(kib) };
    if (dom.currentMemory) {
      dom.currentMemory = { '@_unit': 'KiB', '#text': String(kib) };
    }
    if (isRunning) requiresRestart = true;
  }

  const newVcpus = patch.vcpus != null ? parseInt(patch.vcpus, 10) : null;
  const newCpuMode = patch.cpuMode ?? null;
  const newNestedVirt = patch.nestedVirt ?? null;

  if (newVcpus != null || newCpuMode != null || newNestedVirt != null) {
    const vcpuCount = newVcpus || current.vcpus;
    const cpuMode = newCpuMode || current.cpuMode || 'host-passthrough';

    if (newVcpus != null) {
      dom.vcpu = { '@_placement': 'static', '#text': String(vcpuCount) };
      if (isRunning) requiresRestart = true;
    }

    const existingFeatures = current.cpuFeatures || [];
    let features = existingFeatures.filter((f) => f.name !== 'vmx' && f.name !== 'svm');
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
    if (newCpuMode != null && isRunning) requiresRestart = true;
  }

  if (patch.machineType != null && dom.os?.type) {
    const typeNode = dom.os.type;
    if (typeof typeNode === 'object') {
      typeNode['@_machine'] = patch.machineType;
    }
    if (isRunning) requiresRestart = true;
  }

  if (patch.firmware != null) {
    delete dom.os.loader;
    delete dom.os.nvram;
    delete dom.os.firmware;
    if (dom.os['@_firmware']) delete dom.os['@_firmware'];
    if (patch.firmware === 'uefi' || patch.firmware === 'uefi-secure') {
      dom.os['@_firmware'] = 'efi';
    }
    if (isRunning) requiresRestart = true;
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
    if (isRunning) requiresRestart = true;
  }

  if (patch.nics != null && dom.devices) {
    dom.devices.interface = patch.nics.map((nic, index) => {
      const type = nic.type || 'bridge';
      const iface = { '@_type': type };
      const vlan = normalizeNicVlan(nic, index);
      if (nic.mac) iface.mac = { '@_address': nic.mac };
      if (nic.source) {
        iface.source = type === 'bridge' ? { '@_bridge': nic.source } : { '@_network': nic.source };
      }
      if (nic.model) iface.model = { '@_type': nic.model };
      if (vlan != null) iface.vlan = { tag: { '@_id': String(vlan) } };
      return iface;
    });
  }

  if (patch.videoDriver != null && dom.devices) {
    dom.devices.video = [{ model: { '@_type': patch.videoDriver } }];
  }

  if (patch.graphicsType != null && dom.devices) {
    dom.devices.graphics = [{ '@_type': patch.graphicsType, '@_port': '-1', '@_autoport': 'yes', '@_listen': '0.0.0.0' }];
  }

  if (patch.memBalloon != null && dom.devices) {
    dom.devices.memballoon = [{ '@_model': patch.memBalloon ? 'virtio' : 'none' }];
  }

  if (patch.guestAgent != null && dom.devices) {
    const channels = (dom.devices.channel || []).filter(
      (ch) => !(ch.target && String(ch.target['@_name'] || '').includes('guest_agent'))
    );
    if (patch.guestAgent) {
      channels.push({
        '@_type': 'unix',
        target: { '@_type': 'virtio', '@_name': 'org.qemu.guest_agent.0' },
      });
    }
    if (channels.length) dom.devices.channel = channels;
    else delete dom.devices.channel;
  }

  if (patch.vtpm != null && dom.devices) {
    if (patch.vtpm) {
      dom.devices.tpm = [{ '@_model': 'tpm-tis', backend: { '@_type': 'emulator', '@_version': '2.0' } }];
    } else {
      delete dom.devices.tpm;
    }
    if (isRunning) requiresRestart = true;
  }

  if (patch.virtioRng != null && dom.devices) {
    if (patch.virtioRng) {
      dom.devices.rng = [{ '@_model': 'virtio', backend: { '@_model': 'random', '#text': '/dev/urandom' } }];
    } else {
      delete dom.devices.rng;
    }
  }

  if (patch.iconId !== undefined || patch.localDns !== undefined) {
    setWispMetadata(dom, {
      iconId: patch.iconId !== undefined ? (patch.iconId || null) : current.iconId,
      localDns: patch.localDns !== undefined ? (patch.localDns === true) : current.localDns,
    });
  }

  let outXml;
  try {
    outXml = buildXml(parsed);
  } catch (err) {
    throw vmError('CONFIG_ERROR', 'Failed to build domain XML', err.message);
  }

  try {
    await connectionState.connectIface.DomainDefineXML(outXml);
  } catch (err) {
    throw vmError('LIBVIRT_ERROR', `Failed to update VM "${effectiveName}" configuration`, err.message);
  }

  if (patch.autostart != null) {
    try {
      const newPath = await resolveDomain(effectiveName);
      const { props } = await getDomainObjAndIface(newPath);
      const variant = new dbus.Variant('b', patch.autostart);
      await props.Set('org.libvirt.Domain', 'Autostart', variant);
    } catch (err) {
      /* autostart is optional; domain XML update already succeeded */
      console.warn(`[vmManager] Failed to set autostart:`, err.message);
    }
  }

  // Rename requires VM offline (enforced above), so there's no live mDNS entry
  // under the old name to clean up — when the VM starts again, the publisher's
  // reconcile handles publishing under the new name.
  if (patch.localDns === false) {
    await unpublishVm(effectiveName);
  } else if (patch.localDns === true) {
    await publishVm(effectiveName);
  }

  return { ok: true, requiresRestart };
}
