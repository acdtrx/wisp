/**
 * Container network-state emitter (Linux).
 *
 * Owns the periodic IP probe + container.json persistence and exposes a single
 * subscription on the containerManager facade: `subscribeContainerNetworkChange`.
 *
 * Handler signature: (name, snapshot) where
 *   snapshot = { state, ip }   when running on a bridge network
 *   snapshot = null            when stopped, deleted, or not on a bridge
 *
 * Fires only when (state | ip) differs from the last emitted snapshot. List-
 * cache change events fire on every containerd lifecycle event (/tasks/start,
 * /tasks/exit, /tasks/delete, etc.), so most transitions get a fast-path
 * emission; the 60s timer is the safety net for in-netns DHCP renewals where
 * neither containerd nor Wisp gets a signal.
 *
 * On IP diff for a running bridge container, the new IP is persisted to
 * container.json before the event fires — containerManager owns the durable
 * record, glue (containerMdnsReconciler) reacts only to the event.
 */
import { containerState } from './containerManagerConnection.js';
import { subscribeContainerListChange, listContainers } from './containerManagerList.js';
import { readContainerConfig, writeContainerConfig } from './containerManagerConfigIo.js';
import { discoverIpv4InNetnsOnce } from './containerManagerNetwork.js';

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
  return a.state === b.state && a.ip === b.ip;
}

async function probeAndEmit(name, state) {
  let config;
  try {
    config = await readContainerConfig(name);
  } catch {
    /* container.json missing (mid-create / mid-delete) — skip this tick */
    return;
  }

  // Non-bridge networks (host, none) have no netns IP we can probe — emit a
  // null-ip snapshot so subscribers know there's nothing to publish.
  if (config.network?.type !== 'bridge') {
    const next = { state, ip: null };
    const prev = emittedSnapshots.get(name);
    if (snapshotEqual(prev, next)) return;
    emittedSnapshots.set(name, next);
    fireNetworkChange(name, next);
    return;
  }

  let liveIp = null;
  try {
    liveIp = await discoverIpv4InNetnsOnce(name, 'eth0');
  } catch {
    /* netns missing or helper failed — treat as "no IP this tick" */
  }

  // Persist the live IP to container.json if it diverges. This keeps other
  // consumers of getContainerConfig consistent after a DHCP renewal — they'd
  // otherwise see the IP from the last setupNetwork.
  if (liveIp && config.network?.ip !== liveIp) {
    config.network = { ...(config.network || {}), ip: liveIp };
    try {
      await writeContainerConfig(name, config);
    } catch (err) {
      log().warn?.({ err: err?.message || err, container: name, ip: liveIp }, '[containerManager] persist new IP failed');
    }
  }

  const next = { state, ip: liveIp || config.network?.ip || null };
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
 * (name, snapshot) where snapshot = { state, ip } when running on a bridge,
 * or null when stopped/removed/not-on-bridge. Returns an unsubscribe function.
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
