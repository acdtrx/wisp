/**
 * VM network-state emitter (Linux).
 *
 * Owns the libvirt-internal plumbing for "VM network changed" — DomainEvent,
 * AgentEvent, and a 60s safety probe — and exposes a single platform-agnostic
 * subscription on the vmManager facade: `subscribeVMNetworkChange(handler)`.
 *
 * Handler signature: (name, snapshot) where
 *   snapshot = { stateCode, ip, hostname }   when running
 *   snapshot = null                          when stopped or no longer defined
 *
 * Fires only when (stateCode | ip | hostname) differs from the last emitted
 * snapshot for that VM. Auto-attaches per-domain AgentEvent listeners for every
 * running VM so a fresh qemu-ga connect produces an immediate probe instead of
 * waiting for the next 60s tick.
 */
import {
  connectionState,
  attachAgentSubscription,
  detachAgentSubscription,
  subscribeAgentEvent,
  subscribeDisconnect,
} from './vmManagerConnection.js';
import { subscribeVMListChange, listVMs } from './vmManagerList.js';
import { getGuestNetwork } from './vmManagerStats.js';

const PERIODIC_INTERVAL_MS = 60_000;

const networkChangeHandlers = new Set();
const emittedSnapshots = new Map(); // name -> { stateCode, ip, hostname }
const trackedAgents = new Map();    // name -> domainPath

let reconcileInFlight = false;
let reconcileQueued = false;
let periodicTimer = null;

function log() {
  return connectionState.logger || console;
}

function fireNetworkChange(name, snapshot) {
  for (const h of networkChangeHandlers) {
    try { h(name, snapshot); }
    catch (err) { log().warn?.({ err: err?.message || err }, '[vmManager] vm-network-change handler threw'); }
  }
}

function snapshotEqual(a, b) {
  if (!a || !b) return false;
  return a.stateCode === b.stateCode && a.ip === b.ip && a.hostname === b.hostname;
}

async function probeAndEmit(name, stateCode) {
  let ip = null;
  let hostname = null;
  try {
    const r = await getGuestNetwork(name);
    ip = r.ip ?? null;
    hostname = r.hostname ?? null;
  } catch {
    /* agent not responding — treat as unknown; don't emit on this tick */
  }
  const next = { stateCode, ip, hostname };
  const prev = emittedSnapshots.get(name);
  if (snapshotEqual(prev, next)) return;
  emittedSnapshots.set(name, next);
  fireNetworkChange(name, next);
}

async function reconcile(list) {
  const runningByName = new Map();
  for (const vm of list) {
    if (vm.stateCode === 1) runningByName.set(vm.name, vm);
  }

  // Detach + emit-null for VMs that left the running set (stopped, undefined,
  // suspended, etc.). We treat any non-running state as "no longer interesting"
  // for network-state consumers — the IP the guest had is no longer reachable.
  for (const name of [...emittedSnapshots.keys()]) {
    if (!runningByName.has(name)) {
      const path = trackedAgents.get(name);
      if (path) detachAgentSubscription(path);
      trackedAgents.delete(name);
      emittedSnapshots.delete(name);
      fireNetworkChange(name, null);
    }
  }

  // Auto-attach AgentEvent + probe for every running VM.
  for (const vm of runningByName.values()) {
    const prevPath = trackedAgents.get(vm.name);
    if (prevPath !== vm.domainPath) {
      if (prevPath) detachAgentSubscription(prevPath);
      await attachAgentSubscription(vm.domainPath, vm.name);
      trackedAgents.set(vm.name, vm.domainPath);
    }
    await probeAndEmit(vm.name, vm.stateCode);
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
      const target = list ?? await listVMs();
      await reconcile(target);
    } catch (err) {
      log().warn?.({ err: err?.message || err }, '[vmManager] vm-network-change reconcile failed');
    } finally {
      reconcileInFlight = false;
      if (reconcileQueued) {
        reconcileQueued = false;
        scheduleReconcile();
      }
    }
  });
}

function onAgentEvent(name, { state }) {
  // 1 = connected: agent just came up, fast-path a probe instead of waiting for
  // the next 60s reconcile. 0 = disconnected: leave the snapshot alone (the IP
  // remains valid until lifecycle says otherwise).
  if (state !== 1) return;
  if (!trackedAgents.has(name)) return;
  probeAndEmit(name, 1).catch(() => { /* logged inside */ });
}

function onLibvirtDisconnect() {
  // The connection layer detaches all AgentEvent subscriptions on disconnect,
  // so our trackedAgents iface refs are stale. Clear them along with the
  // snapshot map; the post-reconnect vmListChange will re-attach and re-emit.
  trackedAgents.clear();
  emittedSnapshots.clear();
}

/**
 * Subscribe to VM network-state changes. Handler signature: (name, snapshot)
 * where snapshot = { stateCode, ip, hostname } when running, or null when the
 * VM is no longer running. Returns an unsubscribe function.
 *
 * Replay-on-subscribe: the handler is invoked once per known snapshot
 * synchronously before this function returns, so a late subscriber catches up
 * on running VMs without waiting for the next libvirt event or the 60s probe.
 */
export function subscribeVMNetworkChange(handler) {
  networkChangeHandlers.add(handler);
  for (const [name, snapshot] of emittedSnapshots) {
    try { handler(name, snapshot); }
    catch (err) { log().warn?.({ err: err?.message || err }, '[vmManager] vm-network-change replay handler threw'); }
  }
  return () => networkChangeHandlers.delete(handler);
}

// Module-load wiring (matches vmManagerList.js pattern). subscribeVMListChange
// fires on every libvirt DomainEvent (after the list-cache refresh completes),
// so we get lifecycle-driven probes for free. The 60s timer is a safety net
// for DHCP drift and any missed signals.
subscribeVMListChange((list) => { if (list) scheduleReconcile(list); });
subscribeAgentEvent(onAgentEvent);
subscribeDisconnect(onLibvirtDisconnect);
periodicTimer = setInterval(scheduleReconcile, PERIODIC_INTERVAL_MS);
periodicTimer.unref?.();
