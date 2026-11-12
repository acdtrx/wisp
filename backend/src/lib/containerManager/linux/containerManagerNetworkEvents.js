/**
 * Container network-state emitter (Linux).
 *
 * Owns the periodic IP probe + container.json persistence and exposes a single
 * subscription on the containerManager facade: `subscribeContainerNetworkChange`.
 *
 * Handler signature: (name, snapshot) where
 *   snapshot = { state, ip, ip6 }   when running
 *   snapshot = null                 when stopped or deleted
 *
 * `ip` is the DHCP IPv4; `ip6` is the kernel-SLAAC global IPv6 read from
 * /proc/<taskPid>/net/if_inet6 (null when the LAN advertises no prefix).
 * Nothing in the CNI/DHCP layer asks for IPv6 — it is observed here only.
 *
 * Fires only when (state | ip | ip6) differs from the last emitted snapshot.
 * List-cache change events fire on every containerd lifecycle event
 * (/tasks/start, /tasks/exit, /tasks/delete, etc.), so most transitions get a
 * fast-path emission; the 60s timer is the safety net for in-netns DHCP
 * renewals and SLAAC changes where neither containerd nor Wisp gets a signal.
 *
 * On address diff for a running container, the new addresses are
 * persisted to container.json before the event fires — containerManager owns
 * the durable record, glue (containerMdnsReconciler) reacts only to the event.
 */
import { containerState } from './containerManagerConnection.js';
import { subscribeContainerListChange, listContainers } from './containerManagerList.js';
import { readContainerConfig, writeContainerConfig } from './containerManagerConfigIo.js';
import { discoverIpv4InNetnsOnce } from './containerManagerNetwork.js';
import { getTaskState } from './containerManagerLifecycle.js';
import { tryAcquireOperationLock } from './containerOperationGuard.js';
import { ipv6GlobalCidrFromProcIfInet6 } from '../../networking/index.js';

const PERIODIC_INTERVAL_MS = 60_000;

const networkChangeHandlers = new Set();
const emittedSnapshots = new Map(); // name -> { state, ip }

let reconcileInFlight = false;
let reconcileQueued = false;
let periodicTimer = null;

function log() {
  return containerState.logger || console;
}

function fireNetworkChange(name, snapshot) {
  for (const h of networkChangeHandlers) {
    try { h(name, snapshot); }
    catch (err) { log().warn?.({ err: err?.message || err }, '[containerManager] container-network-change handler threw'); }
  }
}

function snapshotEqual(a, b) {
  if (!a || !b) return false;
  return a.state === b.state && a.ip === b.ip && a.ip6 === b.ip6;
}

async function probeAndEmit(name, state) {
  let config;
  try {
    config = await readContainerConfig(name);
  } catch {
    /* container.json missing (mid-create / mid-delete) — skip this tick */
    return;
  }

  let pid = 0;
  try {
    pid = Number((await getTaskState(name))?.pid) || 0;
  } catch {
    /* task lookup failed — probe without the pid this tick */
  }

  let liveIp = null;
  try {
    liveIp = await discoverIpv4InNetnsOnce(name, 'eth0', pid || null);
  } catch {
    /* netns missing or helper failed — treat as "no IP this tick" */
  }

  let liveIp6 = null;
  try {
    if (pid > 0) liveIp6 = await ipv6GlobalCidrFromProcIfInet6(pid, 'eth0');
  } catch {
    /* task gone mid-tick — treat as "no IPv6 this tick" */
  }

  // Persist live addresses to container.json if they diverge. This keeps other
  // consumers of getContainerConfig consistent after a DHCP renewal or SLAAC
  // change — they'd otherwise see the addresses from the last setupNetwork.
  // The write takes the container's operation lock and merges into the latest
  // file: every other container.json writer runs under that lock (a start, an
  // edit), and writing back `config` — read before the probes above — would
  // revert what one of them wrote meanwhile, e.g. the start clearing the
  // restart-required flag. A busy container is retried on the next probe.
  const ipDiverged = liveIp && config.network?.ip !== liveIp;
  const ip6Diverged = liveIp6 && config.network?.ip6 !== liveIp6;
  if (ipDiverged || ip6Diverged) {
    const release = tryAcquireOperationLock(name, 'network address update');
    if (release) {
      try {
        const latest = await readContainerConfig(name);
        latest.network = { ...(latest.network || {}) };
        if (ipDiverged) latest.network.ip = liveIp;
        if (ip6Diverged) latest.network.ip6 = liveIp6;
        await writeContainerConfig(name, latest);
      } catch (err) {
        log().warn?.({ err: err?.message || err, container: name, ip: liveIp, ip6: liveIp6 }, '[containerManager] persist new IP failed');
      } finally {
        release();
      }
    }
  }

  const next = {
    state,
    ip: liveIp || config.network?.ip || null,
    ip6: liveIp6 || config.network?.ip6 || null,
  };
  const prev = emittedSnapshots.get(name);
  if (snapshotEqual(prev, next)) return;
  emittedSnapshots.set(name, next);
  fireNetworkChange(name, next);
}

async function reconcile(list) {
  const runningByName = new Map();
  for (const c of list) {
    if (c.state === 'running') runningByName.set(c.name, c);
  }

  // Emit null for containers that left the running set (stopped, killed,
  // deleted). Subscribers (e.g. mDNS glue) deregister on null.
  for (const name of [...emittedSnapshots.keys()]) {
    if (!runningByName.has(name)) {
      emittedSnapshots.delete(name);
      fireNetworkChange(name, null);
    }
  }

  // Probe + emit for every running container. probeAndEmit is no-op when the
  // snapshot is unchanged.
  for (const c of runningByName.values()) {
    await probeAndEmit(c.name, c.state);
  }
}

function scheduleReconcile(list) {
  if (!containerState.watchEvents) return;
  if (reconcileInFlight) {
    reconcileQueued = true;
    return;
  }
  reconcileInFlight = true;
  setImmediate(async () => {
    try {
      const target = list ?? await listContainers();
      await reconcile(target);
    } catch (err) {
      log().warn?.({ err: err?.message || err }, '[containerManager] container-network-change reconcile failed');
    } finally {
      reconcileInFlight = false;
      if (reconcileQueued) {
        reconcileQueued = false;
        scheduleReconcile();
      }
    }
  });
}

/**
 * Subscribe to container network-state changes. Handler signature:
 * (name, snapshot) where snapshot = { state, ip, ip6 } when running,
 * or null when stopped/removed. Returns an unsubscribe function.
 *
 * Replay-on-subscribe: the handler is invoked once per known snapshot before
 * this function returns, so a late subscriber catches up on running containers
 * without waiting for the next containerd event or the 60s probe.
 */
export function subscribeContainerNetworkChange(handler) {
  networkChangeHandlers.add(handler);
  for (const [name, snapshot] of emittedSnapshots) {
    try { handler(name, snapshot); }
    catch (err) { log().warn?.({ err: err?.message || err }, '[containerManager] container-network-change replay handler threw'); }
  }
  return () => networkChangeHandlers.delete(handler);
}

// Module-load wiring (matches vmManagerNetwork.js pattern). The list cache
// fires on every containerd lifecycle event + container.json write + connect/
// disconnect — those drive the lifecycle-side of the event stream. The 60s
// timer is the safety net for DHCP drift inside the netns.
subscribeContainerListChange((list) => { if (list) scheduleReconcile(list); });
periodicTimer = setInterval(scheduleReconcile, PERIODIC_INTERVAL_MS);
periodicTimer.unref?.();
