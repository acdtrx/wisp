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

async function fetchVMListFromLibvirt() {
  if (!connectionState.connectIface) return [];

  const paths = await connectionState.connectIface.ListDomains(3);

  const results = await Promise.allSettled(
    paths.map(async (p) => {
      const { iface, props } = await getDomainObjAndIface(p);

      const [xml, [stateCode], autostart] = await Promise.all([
        iface.GetXMLDesc(2),
        iface.GetState(0),
        props.Get('org.libvirt.Domain', 'Autostart').then((v) => !!unwrapVariant(v)).catch(() => false),
      ]);

      const config = parseVMFromXML(xml);
      if (!config) return null;

      return {
        name: config.name,
        uuid: config.uuid,
        state: STATE_NAMES[stateCode] ?? 'unknown',
        stateCode,
        vcpus: config.vcpus,
        memoryMiB: config.memoryMiB,
        osCategory: detectOSCategory(config),
        autostart,
        iconId: config.iconId ?? null,
        localDns: config.localDns ?? false,
      };
    }),
  );

  return results
    .filter((r) => r.status === 'fulfilled' && r.value != null)
    .map((r) => r.value);
}

function refreshVMListCache() {
  if (refreshPromise) {
    refreshQueued = true;
    return;
  }
  refreshQueued = false;
  refreshPromise = fetchVMListFromLibvirt()
    .then((list) => { vmListCache = list; })
    .catch((err) => { console.warn('[vmManager] VM list cache refresh failed:', err.message); })
    .finally(() => {
      refreshPromise = null;
      if (refreshQueued) refreshVMListCache();
    });
}

function invalidateVMListCache() {
  vmListCache = null;
}

subscribeDomainChange(refreshVMListCache);
subscribeDisconnect(invalidateVMListCache);

/**
 * Read localDns for a VM from the cached list (avoids an extra inactive XML fetch in stats).
 * Returns undefined if the cache is not populated or the VM is not found.
 */
export function getCachedLocalDns(name) {
  if (!vmListCache) return undefined;
  return vmListCache.find((v) => v.name === name)?.localDns;
}

/* ── Public API ─────────────────────────────────────────────────────── */

/**
 * Returns the cached VM list enriched with `staleBinary` for running VMs. The cache itself
 * holds only libvirt-derived state; staleness is recomputed on each call (cheap: two fs ops
 * per running VM) because it changes independently of libvirt events (e.g. on qemu upgrade).
 */
export async function listVMs() {
  if (vmListCache === null) {
    vmListCache = await fetchVMListFromLibvirt();
  }
  return Promise.all(
    vmListCache.map(async (v) => ({
      ...v,
      staleBinary: v.stateCode === 1 ? await isVMBinaryStale(v.name) : false,
    })),
  );
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

export async function getVMConfig(name) {
  const path = await resolveDomain(name);
  const { iface, props } = await getDomainObjAndIface(path);

  const [xml, inactiveXml, [stateCode], autostart] = await Promise.all([
    iface.GetXMLDesc(0),
    iface.GetXMLDesc(2),
    iface.GetState(0),
    props.Get('org.libvirt.Domain', 'Autostart').then((v) => !!unwrapVariant(v)).catch(() => false),
  ]);

  const config = parseVMFromXML(xml);
  if (!config) throw vmError('PARSE_ERROR', `Failed to parse XML for VM "${name}"`);

  const inactiveConfig = parseVMFromXML(inactiveXml);
  const disks = await enrichDisksWithSizeGiB(config.disks);

  return {
    ...config,
    disks,
    state: STATE_NAMES[stateCode] ?? 'unknown',
    stateCode,
    osCategory: detectOSCategory(config),
    autostart,
    iconId: (inactiveConfig?.iconId ?? config.iconId) ?? null,
    localDns: inactiveConfig?.localDns ?? config.localDns,
  };
}
