/**
 * VM listing and config (list VMs, get VM config).
 * Maintains an in-memory cache of the VM list, refreshed on DomainEvent signals.
 */
import { getDiskInfo } from '../../storage/index.js';
import {
  connectionState,
  getDomainObjAndIface,
  resolveDomain,
  unwrapVariant,
  vmError,
  subscribeDomainChange,
  subscribeDisconnect,
  subscribeCallFailed,
  getDomainXML,
} from './vmManagerConnection.js';
import { isWispError, wrapVmError } from '../vmManagerShared.js';
import { parseVMFromXML } from './vmManagerXml.js';
import { isVMBinaryStale, getQemuStartTimeMs } from './vmManagerProc.js';
import { pendingRestartInForce } from './vmManagerPendingRestartRule.js';
import { STATE_NAMES, isOfflineState } from './libvirtConstants.js';

/* ── VM list cache (event-driven) ──────────────────────────────────── */

/** The last list read whole, or null: not read yet, or the last read or a later
 *  libvirt call failed, so the next listVMs() reads libvirt again. */
let vmListCache = null;
let readPromise = null;
let refreshQueued = false;
const listChangeHandlers = new Set();

/**
 * Read every domain's summary from libvirt: the whole list, or it throws —
 * NO_CONNECTION without a connection, LIBVIRT_ERROR with libvirt's own text
 * when a call fails.
 */
async function fetchVMListFromLibvirt() {
  if (!connectionState.connectIface) throw vmError('NO_CONNECTION', 'Not connected to libvirt');
  try {
    return await readEveryDomain();
  } catch (err) {
    if (isWispError(err)) throw err;
    throw wrapVmError('LIBVIRT_ERROR', 'Could not read the VM list from libvirt', err);
  }
}

async function readEveryDomain() {
  const paths = await connectionState.connectIface.ListDomains(3);

  const list = await Promise.all(
    paths.map(async (p) => {
      const { iface } = await getDomainObjAndIface(p);

      const [xml, [stateCode]] = await Promise.all([
        iface.GetXMLDesc(2),
        iface.GetState(0),
      ]);

      const config = parseVMFromXML(xml);
      if (!config) throw vmError('PARSE_ERROR', `Failed to parse the definition of domain ${p}`);

      const staleBinary = stateCode === 1 ? await isVMBinaryStale(config.name) : false;
      const startedAt = isOfflineState(stateCode) ? null : await getQemuStartTimeMs(config.name);
      const pendingRestart = pendingRestartInForce(config.pendingRestart, startedAt);

      return {
        name: config.name,
        uuid: config.uuid,
        domainPath: p,
        state: STATE_NAMES[stateCode] ?? 'unknown',
        stateCode,
        vcpus: config.vcpus,
        memoryMiB: config.memoryMiB,
        profile: config.profile,
        iconId: config.iconId ?? null,
        pendingRestart,
        startedAt,
        guestAgent: !!config.guestAgent,
        staleBinary,
      };
    }),
  );
  return list;
}

function fireListChange() {
  for (const h of listChangeHandlers) {
    try { h(vmListCache); } catch (err) { connectionState.logger?.warn?.({ err: err?.message || err }, '[vmManager] vm-list-change handler threw'); }
  }
}

/**
 * Forget the cached list and tell the subscribers (with null), so their next
 * read asks libvirt again and sends what it finds — the list, or its error.
 * Only a cached list is dropped: a read that fails while none is cached
 * changes nothing, so a failing read never sets off another.
 */
function dropVMListCache() {
  if (vmListCache === null) return;
  vmListCache = null;
  fireListChange();
}

/**
 * One read of the list at a time, shared by every caller that asks meanwhile.
 * A read that succeeds becomes the cache and is announced; one that fails
 * drops the cache.
 */
function readVMList() {
  if (!readPromise) {
    readPromise = fetchVMListFromLibvirt()
      .then((list) => { vmListCache = list; fireListChange(); return list; })
      .catch((err) => { dropVMListCache(); throw err; })
      .finally(() => {
        readPromise = null;
        if (refreshQueued) refreshVMListCache();
      });
  }
  return readPromise;
}

/**
 * Read the list again. Called on every libvirt DomainEvent and by the
 * mutation paths (create, delete, rename, config writes): libvirt-dbus's
 * DEFINED events are not reliable enough to carry those. A call while a read
 * is in flight queues exactly one more.
 */
export function refreshVMListCache() {
  // No cache without DomainEvents (listVMs reads libvirt on every call).
  if (!connectionState.watchEvents) return;
  if (readPromise) {
    refreshQueued = true;
    return;
  }
  refreshQueued = false;
  readVMList().catch((err) => {
    connectionState.logger?.warn?.({ err: err.message }, '[vmManager] VM list refresh failed');
  });
}

subscribeDomainChange(refreshVMListCache);
subscribeDisconnect(dropVMListCache);
/* A libvirt call that failed may mean libvirt is gone, which libvirt-dbus
 * reports in no other way: the list is read again on its next use. */
subscribeCallFailed(dropVMListCache);

/**
 * Subscribe to VM list cache changes. Handler fires after each successful read
 * (with the new list) and when the cached list is dropped (with null: a
 * disconnect, a failed read or a failed libvirt call). Returns an unsubscribe
 * function.
 */
export function subscribeVMListChange(handler) {
  listChangeHandlers.add(handler);
  return () => listChangeHandlers.delete(handler);
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
 * Read the qemu process start time (epoch ms) for a VM from the cached list —
 * read from /proc on each list refresh, so it survives Wisp restarts. Returns
 * undefined if the cache is not populated or the VM is not found, null when
 * the VM isn't running or its process couldn't be read.
 */
export function getCachedStartedAt(name) {
  if (!vmListCache) return undefined;
  return vmListCache.find((v) => v.name === name)?.startedAt;
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

/**
 * The name of the VM whose libvirt-dbus domain path is `domainPath`, from the
 * cached list, or null when the cache is not populated or holds no such VM.
 * For an event that carries only the path and may arrive after the domain is
 * gone.
 */
export function getCachedVMName(domainPath) {
  if (!vmListCache) return null;
  return vmListCache.find((v) => v.domainPath === domainPath)?.name ?? null;
}

/* ── Public API ─────────────────────────────────────────────────────── */

/** The VM list, whole, or the error of the read that could not get it. */
export async function listVMs() {
  // Without DomainEvents nothing keeps the cache coherent — read libvirt each time.
  if (!connectionState.watchEvents) return fetchVMListFromLibvirt();
  return vmListCache ?? readVMList();
}

/**
 * Aggregate vCPU and memory allocations across running VMs from the cached list.
 * Zero DBus traffic per call — the cache is refreshed only on libvirt DomainEvent
 * signals (start/stop/define/undefine), so allocations stay accurate without
 * per-tick `GetXMLDesc` calls from the stats SSE.
 */
export async function getRunningVMAllocations() {
  const list = await listVMs();
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
        // No <driver type> means raw to libvirt; read it the same way.
        const info = await getDiskInfo(d.source, { format: d.driverType || 'raw' });
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
 * VMs that reference an absolute file path in any `<disk><source file>`
 * (block disk or CDROM) of their saved definition: the image library refuses
 * to rename or delete a file a VM's next start would miss. Reads the VM list
 * and each VM's definition; a read that fails throws, so a caller that guards
 * a delete refuses it rather than reading the failure as "nobody uses it".
 */
export async function findVMsUsingImage(absPath) {
  const vms = await listVMs();
  const refs = [];
  for (const vm of vms) {
    const config = parseVMFromXML(await getDomainXML(vm.domainPath, { inactive: true }));
    if ((config?.disks || []).some((d) => d.source === absPath)) refs.push(vm.name);
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
    props.Get('org.libvirt.Domain', 'Autostart').then((v) => !!unwrapVariant(v)),
  ]);

  const config = parseVMFromXML(xml);
  if (!config) throw vmError('PARSE_ERROR', `Failed to parse XML for VM "${name}"`);

  const startedAt = isOfflineState(stateCode) ? null : await getQemuStartTimeMs(config.name);
  const pendingRestart = pendingRestartInForce(config.pendingRestart, startedAt);
  const disks = await enrichDisksWithSizeGiB(config.disks);

  return {
    ...config,
    pendingRestart,
    disks,
    state: STATE_NAMES[stateCode] ?? 'unknown',
    stateCode,
    autostart,
  };
}
