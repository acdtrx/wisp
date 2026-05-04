/**
 * VM snapshots: list, create, revert, delete.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { connectionState, resolveDomain, getDomainState, getDomainObjAndIface, unwrapVariant, vmError } from './vmManagerConnection.js';
import { parseSnapshotFromXML, buildXml } from './vmManagerXml.js';
import { getVMBasePath } from './vmManagerPaths.js';
import { validateSnapshotName } from './vmManagerValidation.js';
import { VIR_DOMAIN_SNAPSHOT_CREATE_LIVE } from './libvirtConstants.js';

async function getSnapshotIface(snapshotPath) {
  const obj = await connectionState.bus.getProxyObject('org.libvirt', snapshotPath);
  return obj.getInterface('org.libvirt.DomainSnapshot');
}

function sanitizeSnapshotFilename(name) {
  return String(name).trim().replace(/[^a-zA-Z0-9_-]/g, '_') || 'snapshot';
}

export async function listSnapshots(name) {
  const path = await resolveDomain(name);
  const { iface } = await getDomainObjAndIface(path);
  let paths = await iface.ListDomainSnapshots(0);
  paths = unwrapVariant(paths);
  paths = Array.isArray(paths) ? paths : (paths ? [paths] : []);
  const unwrapped = paths.map(p => unwrapVariant(p)).filter(Boolean);
  const result = [];
  for (const snapPath of unwrapped) {
    try {
      const snapIface = await getSnapshotIface(snapPath);
      const xml = await snapIface.GetXMLDesc(0);
      const info = parseSnapshotFromXML(xml);
      if (info) result.push(info);
    } catch (err) {
      /* skip corrupt or unreadable snapshot entry */
      connectionState.logger?.warn?.({ err: err.message, snapPath }, '[vmManager] Failed to read snapshot');
    }
  }
  return result;
}

export async function createSnapshot(name, snapshotName) {
  validateSnapshotName(snapshotName);
  const path = await resolveDomain(name);
  const state = await getDomainState(path);
  const { iface } = await getDomainObjAndIface(path);
  const isLive = state.code === 1 || state.code === 2 || state.code === 3;
  const flags = isLive ? VIR_DOMAIN_SNAPSHOT_CREATE_LIVE : 0;
  const trimmedName = String(snapshotName).trim();

  let xml;
  if (isLive) {
    const vmBase = getVMBasePath(name);
    const snapDir = join(vmBase, 'snapshots');
    await mkdir(snapDir, { recursive: true });
    const memPath = join(snapDir, `${sanitizeSnapshotFilename(trimmedName)}.mem`);
    xml = buildXml({
      domainsnapshot: {
        name: trimmedName,
        memory: { '@_snapshot': 'external', '@_file': memPath },
      },
    });
  } else {
    xml = buildXml({ domainsnapshot: { name: trimmedName } });
  }

  try {
    await iface.SnapshotCreateXML(xml, flags);
  } catch (err) {
    const msg = err.message || '';
    throw vmError('SNAPSHOT_CREATE_FAILED', `Failed to create snapshot: ${msg}`, msg);
  }
}

export async function revertSnapshot(name, snapshotName) {
  validateSnapshotName(snapshotName);
  const path = await resolveDomain(name);
  const { iface } = await getDomainObjAndIface(path);
  let snapPath;
  try {
    snapPath = await iface.SnapshotLookupByName(snapshotName, 0);
    snapPath = unwrapVariant(snapPath);
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('not found') || msg.includes('Snapshot')) {
      throw vmError('SNAPSHOT_NOT_FOUND', `Snapshot "${snapshotName}" not found`, msg);
    }
    throw vmError('SNAPSHOT_REVERT_FAILED', `Failed to revert to snapshot: ${msg}`, msg);
  }
  try {
    const snapIface = await getSnapshotIface(snapPath);
    await snapIface.Revert(0);
  } catch (err) {
    const msg = err.message || '';
    throw vmError('SNAPSHOT_REVERT_FAILED', `Failed to revert to snapshot: ${msg}`, msg);
  }
}

export async function deleteSnapshot(name, snapshotName) {
  validateSnapshotName(snapshotName);
  const path = await resolveDomain(name);
  const { iface } = await getDomainObjAndIface(path);
  let snapPath;
  try {
    snapPath = await iface.SnapshotLookupByName(snapshotName, 0);
    snapPath = unwrapVariant(snapPath);
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('not found') || msg.includes('Snapshot')) {
      throw vmError('SNAPSHOT_NOT_FOUND', `Snapshot "${snapshotName}" not found`, msg);
    }
    throw vmError('SNAPSHOT_DELETE_FAILED', `Failed to delete snapshot: ${msg}`, msg);
  }
  try {
    const snapIface = await getSnapshotIface(snapPath);
    await snapIface.Delete(0);
  } catch (err) {
    const msg = err.message || '';
    throw vmError('SNAPSHOT_DELETE_FAILED', `Failed to delete snapshot: ${msg}`, msg);
  }
}
