/**
 * VM stats, raw XML, VNC port; guest agent (IP, hostname).
 *
 * Note: this file is intentionally side-effect-free w.r.t. mDNS publishing.
 * Local-DNS registration is owned by lib/linux/vmMdnsPublisher.js, which is
 * driven by libvirt lifecycle + AgentEvent signals, not by SSE/UI activity.
 */
import { connectionState, resolveDomain, getDomainXML, getDomainObjAndIface, unwrapVariant, unwrapDict, vmError } from './vmManagerConnection.js';
import { parseVMFromXML } from './vmManagerXml.js';
import { STATE_NAMES, VIR_DOMAIN_INTERFACE_ADDRESSES_SRC_AGENT, VM_STATS_MASK } from './libvirtConstants.js';
import { getCachedLocalDns, getCachedStaleBinary, getCachedVcpus, getCachedGuestAgent, getCachedStateCode, getCachedDomainPath } from './vmManagerList.js';
import { getRegisteredHostname } from '../../mdnsManager.js';

function parseInterfaceAddresses(raw, unwrapVariantFn) {
  const ifaces = Array.isArray(raw) ? raw : [];
  let ipv4 = null;
  let ipv6 = null;
  for (const entry of ifaces) {
    const arr = Array.isArray(entry) ? entry : [];
    const addrs = Array.isArray(arr[2]) ? arr[2] : [];
    for (const a of addrs) {
      const tuple = Array.isArray(a) ? a : [];
      const type = unwrapVariantFn(tuple[0]);
      const addr = typeof tuple[1] === 'string' ? tuple[1] : unwrapVariantFn(tuple[1]);
      if (type === 0 && addr && !addr.startsWith('127.')) {
        ipv4 = addr.split('/')[0];
        break;
      }
      if (type === 1 && !ipv6 && addr && !addr.startsWith('::1') && !addr.includes('%')) {
        ipv6 = addr.split('/')[0];
      }
    }
    if (ipv4) break;
  }
  return ipv4 || ipv6 || null;
}

export async function getGuestPrimaryAddressFromIface(iface) {
  if (!iface) return null;
  try {
    const raw = await iface.InterfaceAddresses(VIR_DOMAIN_INTERFACE_ADDRESSES_SRC_AGENT, 0);
    const ifaces = unwrapVariant(raw);
    return parseInterfaceAddresses(ifaces, unwrapVariant);
  } catch {
    /* guest agent not installed or not running; interface addresses unavailable */
    return null;
  }
}

export async function getGuestHostnameFromIface(iface) {
  if (!iface) return null;
  try {
    const raw = await iface.GetHostname(0);
    const host = unwrapVariant(raw);
    return typeof host === 'string' && host.trim() ? host.trim() : null;
  } catch {
    /* guest agent not installed or not running; hostname unavailable */
    return null;
  }
}

/**
 * Per-VM guest-agent info cache. qemu-ga `InterfaceAddresses` and `GetHostname` are
 * expensive (libvirtd → virtio-serial → guest agent process inside the VM) and the
 * data they return rarely changes — hostname is set at boot, IP changes on DHCP
 * renewal (typically hours). The per-VM stats SSE refreshes every 5 s but we only
 * hit the agent every GUEST_INFO_TTL_MS, so 5 in 6 ticks read straight from cache.
 *
 * Entries are dropped when the cached state turns non-running, so a stop/start cycle
 * always re-fetches from the live agent on the next running tick.
 */
const guestInfoCache = new Map(); // name -> { ip, hostname, fetchedAt }
const GUEST_INFO_TTL_MS = 30_000;

function invalidateGuestInfo(name) {
  guestInfoCache.delete(name);
}

/**
 * Fetch guest-agent IP + hostname for a VM in one libvirt round-trip.
 * Returns `{ ip, hostname }` with either field possibly null. Used by callers
 * outside `linux/vmManager/` (e.g. vmMdnsPublisher) so they don't need to touch
 * libvirt ifaces directly. Returns `{ ip: null, hostname: null }` if the domain
 * can't be resolved or the agent is not configured/responding.
 */
export async function getGuestNetwork(name) {
  let path;
  try {
    path = await resolveDomain(name);
  } catch {
    return { ip: null, hostname: null };
  }
  const { iface } = await getDomainObjAndIface(path);
  const [ip, hostname] = await Promise.all([
    getGuestPrimaryAddressFromIface(iface),
    getGuestHostnameFromIface(iface),
  ]);
  return { ip, hostname };
}

export async function getVMStats(name) {
  // Fast path for non-running VMs: trust the event-driven cache and skip libvirt
  // entirely. The cache is refreshed on every DomainEvent, so a cached non-running
  // state means the SSE tick costs zero DBus calls until the VM actually starts.
  const cachedState = getCachedStateCode(name);
  if (cachedState !== undefined && cachedState !== 1 && cachedState !== 2 && cachedState !== 3) {
    invalidateGuestInfo(name);
    return { state: STATE_NAMES[cachedState] ?? 'unknown', active: false, cpu: null, disk: null, net: null, uptime: null, staleBinary: false };
  }

  // Resolve the domain path from the cache (set by ListDomains) — saves a per-tick
  // DomainLookupByName. Fall back to the live lookup only if the cache is empty
  // (briefly, during reconnect or before the first refresh has populated it).
  const path = getCachedDomainPath(name) ?? await resolveDomain(name);
  const { iface } = await getDomainObjAndIface(path);
  // No GetState round-trip here: cachedState is kept current via DomainEvent and
  // we already short-circuited any non-running state above. If a state change races
  // the tick, GetStats either returns nothing or errors — both handled below.
  const stateCode = cachedState ?? 1;

  const cachedVcpus = getCachedVcpus(name);
  const localDns = getCachedLocalDns(name) ?? false;
  const now = Date.now();
  const prev = connectionState.prevVMStats.get(name);

  let allStats = {};
  try {
    const raw = await iface.GetStats(VM_STATS_MASK, 0);
    allStats = unwrapDict(raw);
  } catch {
    /* GetStats may not be available for this QEMU/libvirt build */
  }

  let cpuPercent = 0;
  let cpuTime;
  try {
    cpuTime = Number(allStats['cpu.time'] || 0);

    if (!cpuTime) {
      const vcpuCount = Number(allStats['vcpu.current'] || cachedVcpus || 0);
      for (let i = 0; i < vcpuCount; i++) {
        cpuTime = (cpuTime || 0) + Number(allStats[`vcpu.${i}.time`] || 0);
      }
    }

    if (cpuTime && prev?.cpuTime != null && prev.timestamp) {
      const elapsedNs = (now - prev.timestamp) * 1e6;
      const deltaNs = cpuTime - prev.cpuTime;
      const totalCapacity = elapsedNs * (cachedVcpus || 1);
      cpuPercent = totalCapacity > 0 ? Math.min(100, (deltaNs / totalCapacity) * 100) : 0;
    }
  } catch {
    /* stats shape missing or unexpected; leave cpuTime undefined */
    cpuTime = undefined;
  }

  let diskRd = 0;
  let diskWr = 0;
  const blockCount = Number(allStats['block.count'] || 0);
  for (let i = 0; i < blockCount; i++) {
    diskRd += Number(allStats[`block.${i}.rd.bytes`] || 0);
    diskWr += Number(allStats[`block.${i}.wr.bytes`] || 0);
  }

  let netRx = 0;
  let netTx = 0;
  const netCount = Number(allStats['net.count'] || 0);
  for (let i = 0; i < netCount; i++) {
    netRx += Number(allStats[`net.${i}.rx.bytes`] || 0);
    netTx += Number(allStats[`net.${i}.tx.bytes`] || 0);
  }

  let diskRdMBs = 0;
  let diskWrMBs = 0;
  let netRxMBs = 0;
  let netTxMBs = 0;
  if (prev?.timestamp) {
    const elapsed = (now - prev.timestamp) / 1000;
    if (elapsed > 0) {
      diskRdMBs = Math.max(0, (diskRd - (prev.diskRd || 0)) / 1048576 / elapsed);
      diskWrMBs = Math.max(0, (diskWr - (prev.diskWr || 0)) / 1048576 / elapsed);
      netRxMBs = Math.max(0, (netRx - (prev.netRx || 0)) / 1048576 / elapsed);
      netTxMBs = Math.max(0, (netTx - (prev.netTx || 0)) / 1048576 / elapsed);
    }
  }

  connectionState.prevVMStats.set(name, { cpuTime, timestamp: now, diskRd, diskWr, netRx, netTx });

  if (!connectionState.vmStartTimes.has(name)) connectionState.vmStartTimes.set(name, now);

  let guestIp = null;
  let guestHostname = null;
  let guestAgent = null; // null = not configured in domain XML
  if (getCachedGuestAgent(name)) {
    const cached = guestInfoCache.get(name);
    if (cached && (now - cached.fetchedAt) < GUEST_INFO_TTL_MS) {
      guestIp = cached.ip;
      guestHostname = cached.hostname;
    } else {
      try {
        [guestIp, guestHostname] = await Promise.all([
          getGuestPrimaryAddressFromIface(iface),
          getGuestHostnameFromIface(iface),
        ]);
      } catch {
        /* guest agent calls may fail if agent unavailable */
      }
      guestInfoCache.set(name, { ip: guestIp, hostname: guestHostname, fetchedAt: now });
    }
    // Treat any successful response as "agent connected." Both helpers swallow
    // their own errors and return null when qemu-ga isn't responding.
    guestAgent = { connected: !!(guestIp || guestHostname) };
  }
  const staleBinary = getCachedStaleBinary(name);

  return {
    state: STATE_NAMES[stateCode] ?? 'unknown',
    active: true,
    cpu: { percent: Math.round(cpuPercent * 10) / 10 },
    disk: {
      readMBs: Math.round(diskRdMBs * 100) / 100,
      writeMBs: Math.round(diskWrMBs * 100) / 100,
    },
    net: {
      rxMBs: Math.round(netRxMBs * 100) / 100,
      txMBs: Math.round(netTxMBs * 100) / 100,
    },
    uptime: now - connectionState.vmStartTimes.get(name),
    guestIp: guestIp ?? undefined,
    guestHostname: guestHostname ?? undefined,
    guestAgent: guestAgent ?? undefined,
    mdnsHostname: localDns === true ? (getRegisteredHostname(name) ?? undefined) : undefined,
    staleBinary,
  };
}

export async function getVMXML(name) {
  const path = await resolveDomain(name);
  return getDomainXML(path);
}

export async function getVNCPort(name) {
  const path = await resolveDomain(name);
  const xml = await getDomainXML(path);
  const config = parseVMFromXML(xml);
  if (!config) throw vmError('PARSE_ERROR', `Failed to parse XML for VM "${name}"`);
  const g = config.graphics;
  if (!g || g.type !== 'vnc') throw vmError('CONFIG_ERROR', 'VNC not configured or port not available');
  const port = g.port;
  if (typeof port !== 'number' || port <= 0) throw vmError('CONFIG_ERROR', 'VNC port not available (VM may need to be running)');
  return port;
}
