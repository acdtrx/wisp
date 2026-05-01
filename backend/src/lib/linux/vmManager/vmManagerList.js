/**
 * VM listing and config (list VMs, get VM config).
 * Maintains an in-memory cache of the VM list, refreshed on DomainEvent signals.
 */
import { getDiskInfo } from '../../diskOps.js';
import {
  connectionState,
  getDomainObjAndIface,
  resolveDomain,
  unwrapVariant,
  vmError,
  subscribeDomainChange,
  subscribeDisconnect,
} from './vmManagerConnection.js';
import { parseVMFromXML, detectOSCategory } from './vmManagerXml.js';
import { isVMBinaryStale } from './vmManagerProc.js';
import { STATE_NAMES } from './libvirtConstants.js';

/* ── VM list cache (event-driven) ──────────────────────────────────── */

let vmListCache = null;
let refreshPromise = null;
let refreshQueued = false;
const listChangeHandlers = new Set();

async function fetchVMListFromLibvirt() {
  if (!connectionState.connectIface) return [];

  const paths = await connectionState.connectIface.ListDomains(3);

  const results = await Promise.allSettled(
    paths.map(async (p) => {
      const { iface } = await getDomainObjAndIface(p);

      const [xml, [stateCode]] = await Promise.all([
        iface.GetXMLDesc(2),
        iface.GetState(0),
      ]);

      const config = parseVMFromXML(xml);
      if (!config) return null;

      const staleBinary = stateCode === 1 ? await isVMBinaryStale(config.name) : false;

      return {
        name: config.name,
        uuid: config.uuid,
        domainPath: p,
        state: STATE_NAMES[stateCode] ?? 'unknown',
        stateCode,
        vcpus: config.vcpus,
        memoryMiB: config.memoryMiB,
        osCategory: detectOSCategory(config),
        iconId: config.iconId ?? null,
        localDns: config.localDns ?? false,
        guestAgent: !!config.guestAgent,
        staleBinary,
      };
    }),
  );

  return results
    .filter((r) => r.status === 'fulfilled' && r.value != null)
    .map((r) => r.value);
}

function fireListChange() {
  for (const h of listChangeHandlers) {
    try { h(vmListCache); } catch (err) { connectionState.logger?.warn?.({ err: err?.message || err }, '[vmManager] vm-list-change handler threw'); }
  }
}

/**
 * Trigger a VM list cache refresh. Called by the DomainEvent listener (lifecycle
 * events from libvirt-dbus) and explicitly by mutation paths in vmManager
 * (create/clone/delete/rename), since libvirt-dbus DEFINED events have proven
 * unreliable enough that new VMs would otherwise miss the LeftBar until a manual
 * page refresh. Idempotent: a second call while a refresh is in flight queues
 * exactly one follow-up. Mirrors containerManager's subscribeContainerConfigWrite.
 */
export function refreshVMListCache() {
  if (refreshPromise) {
    refreshQueued = true;
    return;
  }
  refreshQueued = false;
  refreshPromise = fetchVMListFromLibvirt()
    .then((list) => { vmListCache = list; fireListChange(); })
    .catch((err) => { connectionState.logger?.warn?.({ err: err.message }, '[vmManager] VM list cache refresh failed'); })
    .finally(() => {
      refreshPromise = null;
      if (refreshQueued) refreshVMListCache();
    });
}

function invalidateVMListCache() {
  vmListCache = null;
  fireListChange();
}

subscribeDomainChange(refreshVMListCache);
subscribeDisconnect(invalidateVMListCache);

/**
 * Subscribe to VM list cache changes. Handler fires after each successful refresh
 * (with the new list) and on disconnect (with null). Returns an unsubscribe function.
 */
export function subscribeVMListChange(handler) {
  listChangeHandlers.add(handler);
  return () => listChangeHandlers.delete(handler);
}

/**
 * Read localDns for a VM from the cached list (avoids an extra inactive XML fetch in stats).
 * Returns undefined if the cache is not populated or the VM is not found.
 */
export function getCachedLocalDns(name) {
  if (!vmListCache) return undefined;
  return vmListCache.find((v) => v.name === name)?.localDns;
}

/**
 * Read staleBinary for a VM from the cached list. Returns false if the cache is not
 * populated or the VM is not found. Stale state refreshes on libvirt domain events
 * and on qemu binary replacement (see watchQemuBinaries).
 */
export function getCachedStaleBinary(name) {
  if (!vmListCache) return false;
  return vmListCache.find((v) => v.name === name)?.staleBinary ?? false;
}

/**
 * Read vcpu count for a VM from the cached list. Returns undefined if the cache is
 * not populated or the VM is not found — callers should treat that as "unknown" and
 * fall back accordingly (e.g. CPU% computation).
 */
export function getCachedVcpus(name) {
  if (!vmListCache) return undefined;
  return vmListCache.find((v) => v.name === name)?.vcpus;
}

/**
 * Read whether the qemu guest agent is configured in the domain XML, from the cached
 * list. Returns false if the cache is not populated or the VM is not found — getVMStats
 * uses this to decide whether to attempt agent calls (InterfaceAddresses, GetHostname).
 */
export function getCachedGuestAgent(name) {
  if (!vmListCache) return false;
  return vmListCache.find((v) => v.name === name)?.guestAgent ?? false;
}

/**
 * Read libvirt state code for a VM from the cached list. Returns undefined if the
 * cache is not populated or the VM is not found. The cache is refreshed on every
 * DomainEvent, so a non-running cached state can be trusted for short-circuiting
 * per-tick libvirt traffic in `getVMStats` (the next DomainEvent fires the moment
 * the VM starts and the next tick will see running).
 */
export function getCachedStateCode(name) {
  if (!vmListCache) return undefined;
  return vmListCache.find((v) => v.name === name)?.stateCode;
}

/**
 * Read the libvirt-dbus domain path for a VM from the cached list. Returns undefined
 * if the cache is not populated or the VM is not found — callers should fall back to
 * `resolveDomain(name)` (one `DomainLookupByName` round-trip) on cache miss. The path
 * is captured from `ListDomains` during cache population and is stable for the lifetime
 * of the domain definition (libvirt keys paths by UUID).
 */
export function getCachedDomainPath(name) {
  if (!vmListCache) return undefined;
  return vmListCache.find((v) => v.name === name)?.domainPath;
}

/* ── Public API ─────────────────────────────────────────────────────── */

export async function listVMs() {
  if (vmListCache === null) {
    vmListCache = await fetchVMListFromLibvirt();
  }
  return vmListCache;
}

/**
 * Aggregate vCPU and memory allocations across running VMs from the cached list.
 * Zero DBus traffic per call — the cache is refreshed only on libvirt DomainEvent
 * signals (start/stop/define/undefine), so allocations stay accurate without
 * per-tick `GetXMLDesc` calls from the stats SSE.
 */
export async function getRunningVMAllocations() {
  const list = vmListCache ?? await listVMs();
  let vcpus = 0;
  let memoryBytes = 0;
  let count = 0;
  for (const vm of list) {
    if (vm.stateCode !== 1) continue;
    vcpus += vm.vcpus;
    memoryBytes += vm.memoryMiB * 1024 * 1024;
    count += 1;
  }
  return { vcpus, memoryBytes, count };
}

/** Add sizeGiB (virtual size, rounded) to each file-backed block disk; on qemu-img failure, disk is unchanged. */
async function enrichDisksWithSizeGiB(disks) {
  if (!Array.isArray(disks)) return disks;
  return Promise.all(
    disks.map(async (d) => {
      if (d.device !== 'disk' || !d.source || typeof d.source !== 'string') return d;
      try {
        const info = await getDiskInfo(d.source);
        const sizeGiB = Math.round(info.virtualSize / (1024 ** 3));
        return { ...d, sizeGiB };
      } catch {
        /* missing image or qemu-img error — omit sizeGiB */
        return d;
      }
    }),
  );
}

/**
 * Find VMs that reference an absolute file path in any `<disk><source file>`
 * (block disk or CDROM). Used by the image library to refuse rename/delete on
 * files that are still attached — otherwise a VM's next start would fail with
 * "no such file" because the domain XML still points at the old/missing path.
 *
 * Returns an array of VM names. Empty array means no references found.
 */
export async function findVMsUsingImage(absPath) {
  if (!absPath || typeof absPath !== 'string') return [];
  const target = String(absPath);
  const refs = [];
  let domainPaths;
  try {
    domainPaths = await connectionState.connectIface.ListDomains(3);
  } catch {
    return [];
  }
  for (const dp of domainPaths) {
    try {
      const { iface } = await getDomainObjAndIface(dp);
      const xml = await iface.GetXMLDesc(2);
      const config = parseVMFromXML(xml);
      if (!config) continue;
      const inUse = (config.disks || []).some((d) => d.source === target);
      if (inUse) refs.push(config.name);
    } catch {
      /* skip VM if XML unavailable — best-effort scan */
    }
  }
  return refs;
}

export async function getVMConfig(name) {
  const path = await resolveDomain(name);
  const { iface, props } = await getDomainObjAndIface(path);

  // Read inactive XML: DomainDefineXML writes here, so this is what reflects saved config on running VMs.
  const [xml, [stateCode], autostart] = await Promise.all([
    iface.GetXMLDesc(2),
    iface.GetState(0),
    props.Get('org.libvirt.Domain', 'Autostart').then((v) => !!unwrapVariant(v)).catch(() => false),
  ]);

  const config = parseVMFromXML(xml);
  if (!config) throw vmError('PARSE_ERROR', `Failed to parse XML for VM "${name}"`);

  const disks = await enrichDisksWithSizeGiB(config.disks);

  return {
    ...config,
    disks,
    state: STATE_NAMES[stateCode] ?? 'unknown',
    stateCode,
    osCategory: detectOSCategory(config),
    autostart,
  };
}
