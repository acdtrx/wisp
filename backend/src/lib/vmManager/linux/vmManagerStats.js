/**
 * VM stats, raw XML, VNC port; guest agent (IP, hostname).
 */
import {
  connectionState,
  resolveDomain,
  getDomainXML,
  getDomainObjAndIface,
  unwrapVariant,
  unwrapDict,
  vmError,
  subscribeAgentEvent,
  attachAgentSubscription,
  detachAgentSubscription,
} from './vmManagerConnection.js';
import { parseVMFromXML } from './vmManagerXml.js';
import {
  STATE_NAMES, VIR_DOMAIN_INTERFACE_ADDRESSES_SRC_AGENT, VIR_DOMAIN_STATE_RUNNING, VM_STATS_MASK, isShutOff,
} from './libvirtConstants.js';
import {
  getVMConfig,
  subscribeVMListChange,
  getCachedStaleBinary,
  getCachedVcpus,
  getCachedGuestAgent,
  getCachedStateCode,
  getCachedDomainPath,
  getCachedStartedAt,
} from './vmManagerList.js';

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
      if (type === 0 && addr && !addr.startsWith('127.') && !addr.startsWith('169.254.')) {
        ipv4 = addr.split('/')[0];
        break;
      }
      if (type === 1 && !ipv6 && addr && !addr.startsWith('::1') && !addr.toLowerCase().startsWith('fe80:') && !addr.includes('%')) {
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
 * Per-VM guest-agent info cache, the one every reader of the guest's address and
 * name goes through (the stats stream, the VM read, the deployment overview).
 * qemu-ga `InterfaceAddresses` and `GetHostname` are expensive (libvirtd →
 * virtio-serial → guest agent process inside the VM) and the data they return
 * rarely changes — hostname is set at boot, IP changes on DHCP renewal
 * (typically hours). The per-VM stats SSE refreshes every 5 s but we only hit
 * the agent every GUEST_INFO_TTL_MS, so 5 in 6 ticks read straight from cache.
 *
 * Invalidation happens on three boundaries: cached state turns non-running (stop /
 * start cycles re-fetch on the next running tick), libvirt AgentLifecycle fires
 * (a fresh qemu-ga connect/disconnect collapses lag from up to 30 s to one stats
 * tick — important for first-boot installs via cloud-init), and TTL expiry covers
 * the rest (DHCP renewals, hostnamectl, missed signals).
 */
const guestInfoCache = new Map(); // name -> { ip, hostname, fetchedAt }
const GUEST_INFO_TTL_MS = 30_000;

function invalidateGuestInfo(name) {
  guestInfoCache.delete(name);
}

/**
 * The guest's `{ ip, hostname }` from the cache, or asked of its agent when the
 * cache holds none younger than GUEST_INFO_TTL_MS. Either is null when the
 * agent does not answer: the two helpers swallow its errors.
 */
async function readGuestInfo(name, agentIface) {
  const now = Date.now();
  const cached = guestInfoCache.get(name);
  if (cached && (now - cached.fetchedAt) < GUEST_INFO_TTL_MS) return { ip: cached.ip, hostname: cached.hostname };
  const [ip, hostname] = await Promise.all([
    getGuestPrimaryAddressFromIface(agentIface),
    getGuestHostnameFromIface(agentIface),
  ]);
  guestInfoCache.set(name, { ip, hostname, fetchedAt: now });
  return { ip, hostname };
}

// AgentLifecycle on either edge (connect or disconnect) means our cached probe
// result is now stale — drop it so the next stats tick re-probes fresh.
subscribeAgentEvent((name) => { invalidateGuestInfo(name); });

/**
 * libvirt-dbus emits AgentEvent on each domain's own object, so a listener is
 * attached to every running VM and detached once it leaves the running set,
 * in step with the VM list. One pass at a time, each attach awaited: an
 * attach checks, awaits the domain's proxy, then records its listener, so two
 * passes at once could attach one VM twice, or land an attach after the pass
 * that detached it. A list that arrives meanwhile is applied after the pass,
 * the newest only. On a disconnect (list null) the connection layer has
 * already dropped every listener.
 */
let pendingAgentList = null;
let agentPassRunning = false;

async function applyAgentListeners(list) {
  const running = new Map(list.filter((vm) => !isShutOff(vm.stateCode)).map((vm) => [vm.domainPath, vm.name]));
  for (const path of [...connectionState.agentSubscriptions.keys()]) {
    if (!running.has(path)) detachAgentSubscription(path);
  }
  for (const [path, name] of running) await attachAgentSubscription(path, name);
}

async function listenToRunningAgents(list) {
  pendingAgentList = list;
  if (!list || agentPassRunning) return;
  agentPassRunning = true;
  try {
    while (pendingAgentList) {
      const next = pendingAgentList;
      pendingAgentList = null;
      await applyAgentListeners(next);
    }
  } catch (err) {
    connectionState.logger?.warn?.({ err: err?.message || err }, '[vmManager] guest-agent listener pass failed');
  } finally {
    agentPassRunning = false;
  }
}

subscribeVMListChange((list) => { listenToRunningAgents(list); });

/**
 * A running VM's guest-agent IP + hostname, through the cache: `{ ip, hostname }`,
 * either field null when the agent is not configured or not responding; a VM
 * that cannot be looked up throws. `domainPath` (a VM list row's) saves the
 * lookup by name.
 */
export async function getGuestNetwork(name, { domainPath } = {}) {
  const path = domainPath ?? getCachedDomainPath(name) ?? await resolveDomain(name);
  const { agentIface } = await getDomainObjAndIface(path);
  return readGuestInfo(name, agentIface);
}

/**
 * The VM read (`GET /api/vms/:name`, MCP's get_vm): the saved configuration
 * and state, and `guestNetwork`, the guest's `{ ip, hostname }`. The guest is
 * asked only while the VM runs with the agent configured, so a VM that is off
 * or has no agent reads as fast as its configuration; a guest that does not
 * answer reads as nulls, never as a failed read.
 */
export async function getVMDetail(name) {
  const { _hostdevs, ...config } = await getVMConfig(name);
  if (config.stateCode !== VIR_DOMAIN_STATE_RUNNING || !config.guestAgent) {
    if (isShutOff(config.stateCode)) invalidateGuestInfo(name);
    return { ...config, guestNetwork: { ip: null, hostname: null } };
  }
  return { ...config, guestNetwork: await getGuestNetwork(name) };
}

function offlineStats(stateCode) {
  return { state: STATE_NAMES[stateCode] ?? 'unknown', active: false, cpu: null, disk: null, net: null, uptime: null, staleBinary: false };
}

export async function getVMStats(name) {
  // Fast path for non-running VMs: trust the event-driven cache and skip libvirt
  // entirely. The cache is refreshed on every DomainEvent, so a cached non-running
  // state means the SSE tick costs zero DBus calls until the VM actually starts.
  const cachedState = getCachedStateCode(name);
  if (cachedState !== undefined && isShutOff(cachedState)) {
    invalidateGuestInfo(name);
    return offlineStats(cachedState);
  }

  // The domain path and state from the cache (set by ListDomains) save a per-tick
  // DomainLookupByName and GetState; with no cached list (before the first read,
  // or after a failed one) both are read from libvirt.
  const path = getCachedDomainPath(name) ?? await resolveDomain(name);
  const { iface, agentIface } = await getDomainObjAndIface(path);
  const stateCode = cachedState ?? (await iface.GetState(0))[0];
  if (isShutOff(stateCode)) {
    invalidateGuestInfo(name);
    return offlineStats(stateCode);
  }
  // A GetStats that fails (libvirt gone, or the VM stopped as the tick ran)
  // fails the tick: its figures are missing, never zeros.

  const cachedVcpus = getCachedVcpus(name);
  const now = Date.now();
  const prev = connectionState.prevVMStats.get(path);

  const allStats = unwrapDict(await iface.GetStats(VM_STATS_MASK, 0));

  let cpuPercent = 0;
  let cpuTime = Number(allStats['cpu.time'] || 0);
  if (!cpuTime) {
    const vcpuCount = Number(allStats['vcpu.current'] || cachedVcpus || 0);
    for (let i = 0; i < vcpuCount; i++) {
      cpuTime += Number(allStats[`vcpu.${i}.time`] || 0);
    }
  }
  if (cpuTime && prev?.cpuTime != null && prev.timestamp) {
    const elapsedNs = (now - prev.timestamp) * 1e6;
    const deltaNs = cpuTime - prev.cpuTime;
    const totalCapacity = elapsedNs * (cachedVcpus || 1);
    cpuPercent = totalCapacity > 0 ? Math.min(100, (deltaNs / totalCapacity) * 100) : 0;
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

  connectionState.prevVMStats.set(path, { cpuTime, timestamp: now, diskRd, diskWr, netRx, netTx });

  if (!connectionState.vmStartTimes.has(path)) connectionState.vmStartTimes.set(path, now);

  let guestIp = null;
  let guestHostname = null;
  let guestAgent = null; // null = not configured in domain XML
  if (getCachedGuestAgent(name)) {
    ({ ip: guestIp, hostname: guestHostname } = await readGuestInfo(name, agentIface));
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
    uptime: now - (getCachedStartedAt(name) ?? connectionState.vmStartTimes.get(path)),
    guestIp: guestIp ?? undefined,
    guestHostname: guestHostname ?? undefined,
    guestAgent: guestAgent ?? undefined,
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
