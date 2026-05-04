/**
 * VM rename mechanics: relocate the on-disk directory and rewrite every
 * absolute path that referenced the old directory.
 *
 * This is split out of vmManagerConfig so the rename branch reads top-to-bottom
 * without burying the rest of updateVMConfig in path-rewriting boilerplate.
 *
 * State touched:
 *   - libvirt domain XML: `<disk><source file>`, `<os><nvram>`, `<os><loader>`,
 *     and any other `@_file` attribute under devices that points at the per-VM
 *     directory.
 *   - libvirt domain snapshot XMLs: `<memory @file>` for external memory snapshots.
 *
 * Out of scope:
 *   - Image library / shared images (those live under getImagePath, not the
 *     per-VM dir, so rewriting wouldn't apply).
 *   - Backups (they reference vmBasePath in the manifest at backup time;
 *     a rename happens after a backup was taken, so the backup keeps the old
 *     path — that's expected, restore re-creates the per-VM dir under the
 *     current name).
 */
import { rename as fsRename, access } from 'node:fs/promises';
import { dirname } from 'node:path';

import { connectionState, getDomainObjAndIface, vmError, unwrapVariant } from './vmManagerConnection.js';
import { parseDomainRaw, buildXml } from './vmManagerXml.js';
import { VIR_DOMAIN_SNAPSHOT_CREATE_REDEFINE } from './libvirtConstants.js';

function startsWithDir(filePath, dir) {
  if (typeof filePath !== 'string') return false;
  return filePath === dir || filePath.startsWith(`${dir}/`);
}

/**
 * Walk every absolute path declared in the parsed domain and return them in
 * a flat list. Used to discover the per-VM directory at rename time without
 * trusting that it matches `getVMBasePath(name)` — pre-fix renames left
 * legacy state where the dir name and the libvirt domain name diverged.
 */
function collectAbsolutePaths(dom) {
  const paths = [];
  if (!dom) return paths;
  const disks = dom.devices?.disk;
  const list = Array.isArray(disks) ? disks : (disks ? [disks] : []);
  for (const d of list) {
    const f = d?.source?.['@_file'];
    if (typeof f === 'string' && f.startsWith('/')) paths.push(f);
  }
  const os = dom.os;
  if (os) {
    if (typeof os.nvram === 'string' && os.nvram.startsWith('/')) paths.push(os.nvram);
    else if (os.nvram && typeof os.nvram === 'object' && typeof os.nvram['#text'] === 'string'
      && os.nvram['#text'].startsWith('/')) paths.push(os.nvram['#text']);
    if (os.loader && typeof os.loader === 'object' && typeof os.loader['#text'] === 'string'
      && os.loader['#text'].startsWith('/')) paths.push(os.loader['#text']);
  }
  return paths;
}

/**
 * Pick the per-VM directory the domain actually uses on disk.
 *
 * Strategy: walk every absolute path the domain references and find the
 * deepest directory under `vmsRoot` (i.e. `<vmsRoot>/<somename>`). If two or
 * more candidates exist, pick the one that hosts the most paths (handles a
 * VM that mixes a per-VM disk with a CDROM from the shared image library).
 * Returns null if no path lives under vmsRoot — happens for VMs whose disks
 * all live in the shared image library (rare, e.g. CDROM-only VMs).
 */
export function findActualVmDir(dom, vmsRoot) {
  if (!vmsRoot) return null;
  const root = vmsRoot.replace(/\/+$/, '');
  const counts = new Map();
  for (const p of collectAbsolutePaths(dom)) {
    const parent = dirname(p);
    if (parent === root || parent.startsWith(`${root}/`)) {
      // Take the immediate child of vmsRoot — i.e. <vmsRoot>/<name>.
      let candidate = parent;
      while (dirname(candidate) !== root && candidate !== root) {
        candidate = dirname(candidate);
      }
      if (candidate === root) continue;
      counts.set(candidate, (counts.get(candidate) || 0) + 1);
    }
  }
  if (counts.size === 0) return null;
  let best = null;
  let bestCount = -1;
  for (const [dir, n] of counts) {
    if (n > bestCount) { best = dir; bestCount = n; }
  }
  return best;
}

function rewriteAbs(filePath, oldDir, newDir) {
  if (!startsWithDir(filePath, oldDir)) return filePath;
  if (filePath === oldDir) return newDir;
  return `${newDir}${filePath.slice(oldDir.length)}`;
}

/**
 * Mutates the parsed domain object in place. Returns count of paths rewritten.
 */
export function rewriteDomainPaths(dom, oldDir, newDir) {
  if (!dom) return 0;
  let n = 0;

  // Disks: <disk><source file=".."/></disk>
  const disks = dom.devices?.disk;
  const diskList = Array.isArray(disks) ? disks : (disks ? [disks] : []);
  for (const d of diskList) {
    const src = d?.source;
    if (src && typeof src === 'object' && typeof src['@_file'] === 'string') {
      const next = rewriteAbs(src['@_file'], oldDir, newDir);
      if (next !== src['@_file']) {
        src['@_file'] = next;
        n += 1;
      }
    }
  }

  // OS: <os><nvram>...</nvram><loader readonly='no'>...</loader></os>
  const os = dom.os;
  if (os) {
    if (typeof os.nvram === 'string') {
      const next = rewriteAbs(os.nvram, oldDir, newDir);
      if (next !== os.nvram) { os.nvram = next; n += 1; }
    } else if (os.nvram && typeof os.nvram === 'object' && typeof os.nvram['#text'] === 'string') {
      const next = rewriteAbs(os.nvram['#text'], oldDir, newDir);
      if (next !== os.nvram['#text']) { os.nvram['#text'] = next; n += 1; }
    }
    // Writable loader (UEFI VARS template path) — we don't usually write
    // here, but rewrite defensively if it points into the per-VM dir.
    if (os.loader && typeof os.loader === 'object' && typeof os.loader['#text'] === 'string') {
      const next = rewriteAbs(os.loader['#text'], oldDir, newDir);
      if (next !== os.loader['#text']) { os.loader['#text'] = next; n += 1; }
    }
  }

  return n;
}

async function getSnapshotIface(snapshotPath) {
  const obj = await connectionState.bus.getProxyObject('org.libvirt', snapshotPath);
  return obj.getInterface('org.libvirt.DomainSnapshot');
}

/**
 * Walks every snapshot of `domPath`, rewrites `<memory @file>` to point at the
 * new directory, and redefines the snapshot via SnapshotCreateXML with
 * VIR_DOMAIN_SNAPSHOT_CREATE_REDEFINE so libvirt updates the metadata in
 * place (no live state change). Best-effort per snapshot; a failure on one
 * snapshot does not abort the others — caller logs.
 */
export async function rewriteSnapshotMemoryPaths(domPath, oldDir, newDir, log) {
  const { iface } = await getDomainObjAndIface(domPath);
  let snapPaths;
  try {
    snapPaths = await iface.ListDomainSnapshots(0);
  } catch (err) {
    log?.warn?.({ err: err.message }, 'Failed to list snapshots during rename');
    return { rewritten: 0, failed: 0 };
  }
  snapPaths = unwrapVariant(snapPaths);
  snapPaths = Array.isArray(snapPaths) ? snapPaths : (snapPaths ? [snapPaths] : []);
  const unwrapped = snapPaths.map((p) => unwrapVariant(p)).filter(Boolean);

  let rewritten = 0;
  let failed = 0;
  for (const snapPath of unwrapped) {
    try {
      const snapIface = await getSnapshotIface(snapPath);
      const xml = await snapIface.GetXMLDesc(0);
      const parsed = parseDomainRaw(xml);
      const snap = parsed.domainsnapshot;
      if (!snap) continue;
      const mem = snap.memory;
      if (!mem || typeof mem !== 'object' || typeof mem['@_file'] !== 'string') continue;
      const next = rewriteAbs(mem['@_file'], oldDir, newDir);
      if (next === mem['@_file']) continue;
      mem['@_file'] = next;
      const newXml = buildXml(parsed);
      await iface.SnapshotCreateXML(newXml, VIR_DOMAIN_SNAPSHOT_CREATE_REDEFINE);
      rewritten += 1;
    } catch (err) {
      failed += 1;
      log?.warn?.({ snapPath, err: err.message }, 'Failed to rewrite snapshot memory path');
    }
  }
  return { rewritten, failed };
}

/**
 * Move a per-VM directory atomically. Same-filesystem rename(2). Returns
 * `true` on success, `false` only when `oldDir` does not exist (caller decides
 * whether that's acceptable). Any other failure throws a structured vmError
 * so the caller can roll back the libvirt rename.
 */
export async function moveVmDirectory(oldDir, newDir) {
  try {
    await fsRename(oldDir, newDir);
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw vmError('CONFIG_ERROR', `Failed to move VM directory: ${err.message}`, err.message);
  }
  return true;
}

export async function pathExists(p) {
  try { await access(p); return true; }
  catch { return false; }
}
