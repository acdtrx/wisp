/**
 * VM mDNS publisher (Linux). Owns the desired→actual mapping for VM mDNS entries
 * so publishing is never coupled to the UI/SSE stats stream.
 *
 * Triggers:
 *   - boot (initial reconcile after libvirt + avahi connect)
 *   - libvirt DomainEvent (any lifecycle change, including externally-started VMs)
 *   - libvirt AgentEvent (qemu-ga connect → publish immediately, no IP-fetch retry loop)
 *   - explicit publishVm/unpublishVm from the config endpoint (toggle, rename)
 *   - periodic 45s safety net (covers DHCP drift, missed signals)
 *
 * Desired set = running VMs whose Wisp metadata has localDns=true.
 * Tracking maps domainPath ↔ name and lets us detach AgentEvent subscriptions
 * cleanly when a VM stops or has localDns turned off.
 */
import {
  attachAgentSubscription,
  detachAgentSubscription,
  resolveDomain,
  subscribeAgentEvent,
  subscribeDisconnect,
  subscribeDomainChange,
} from './vmManager/vmManagerConnection.js';
import { getGuestNetwork } from './vmManager/vmManagerStats.js';
import { listVMs } from './vmManager/vmManagerList.js';
import { deregisterAddress, registerAddress, sanitizeHostname } from '../mdns/index.js';

const PERIODIC_INTERVAL_MS = 45_000;

const state = {
  logger: null,
  /** name -> { domainPath } — VMs we currently care about (running + localDns). */
  tracked: new Map(),
  unsubDomain: null,
  unsubAgent: null,
  unsubDisconnect: null,
  periodicTimer: null,
  reconcileInFlight: false,
  reconcileQueued: false,
};

function log() {
  return state.logger || console;
}

async function tryPublish(name) {
  try {
    const { ip, hostname } = await getGuestNetwork(name);
    if (ip) {
      await registerAddress(name, hostname || sanitizeHostname(name), ip);
    }
    // No IP yet: leave any prior entry in place; AgentEvent or periodic reconcile will retry.
  } catch (err) {
    log().warn?.({ err: err?.message || err, vm: name }, '[vmMdns] tryPublish failed');
  }
}

async function ensureTracked(name) {
  let path;
  try {
    path = await resolveDomain(name);
  } catch {
    return;
  }
  const cur = state.tracked.get(name);
  if (!cur || cur.domainPath !== path) {
    if (cur?.domainPath) detachAgentSubscription(cur.domainPath);
    await attachAgentSubscription(path, name);
    state.tracked.set(name, { domainPath: path });
  }
  await tryPublish(name);
}

async function dropTracked(name) {
  const cur = state.tracked.get(name);
  if (cur?.domainPath) detachAgentSubscription(cur.domainPath);
  state.tracked.delete(name);
  await deregisterAddress(name);
}

async function reconcileNow() {
  let vms;
  try {
    vms = await listVMs();
  } catch (err) {
    log().warn?.({ err: err?.message || err }, '[vmMdns] reconcile listVMs failed');
    return;
  }
  const desired = vms.filter((v) => v.stateCode === 1 && v.localDns === true);
  const desiredNames = new Set(desired.map((v) => v.name));

  for (const name of [...state.tracked.keys()]) {
    if (!desiredNames.has(name)) await dropTracked(name);
  }
  for (const v of desired) {
    await ensureTracked(v.name);
  }
}

function scheduleReconcile() {
  if (state.reconcileInFlight) {
    state.reconcileQueued = true;
    return;
  }
  state.reconcileInFlight = true;
  setImmediate(async () => {
    try {
      await reconcileNow();
    } finally {
      state.reconcileInFlight = false;
      if (state.reconcileQueued) {
        state.reconcileQueued = false;
        scheduleReconcile();
      }
    }
  });
}

function onAgentEvent(name, { state: agentState }) {
  // 1 = connected: agent just came up, publish without waiting for the next 45s reconcile.
  // 0 = disconnected: leave the entry alone (the IP is still valid until lifecycle says otherwise).
  if (agentState !== 1) return;
  if (!state.tracked.has(name)) return;
  tryPublish(name).catch(() => { /* logged inside */ });
}

function onLibvirtDisconnect() {
  // The connection layer detaches all AgentEvent subscriptions on disconnect, so
  // our `tracked` paths point at iface objects that no longer have listeners. Clear
  // the map so the post-reconnect reconcile re-attaches subscriptions cleanly.
  state.tracked.clear();
}

export function startVmMdnsPublisher(logger) {
  if (state.unsubDomain) return; // already started
  state.logger = logger || null;
  state.unsubDomain = subscribeDomainChange(scheduleReconcile);
  state.unsubAgent = subscribeAgentEvent(onAgentEvent);
  state.unsubDisconnect = subscribeDisconnect(onLibvirtDisconnect);
  scheduleReconcile();
  state.periodicTimer = setInterval(scheduleReconcile, PERIODIC_INTERVAL_MS);
}

export function stopVmMdnsPublisher() {
  if (state.periodicTimer) {
    clearInterval(state.periodicTimer);
    state.periodicTimer = null;
  }
  if (state.unsubDomain) { state.unsubDomain(); state.unsubDomain = null; }
  if (state.unsubAgent) { state.unsubAgent(); state.unsubAgent = null; }
  if (state.unsubDisconnect) { state.unsubDisconnect(); state.unsubDisconnect = null; }
  for (const t of state.tracked.values()) {
    if (t.domainPath) detachAgentSubscription(t.domainPath);
  }
  state.tracked.clear();
}

/**
 * Force a publish attempt for a single VM (called by the config endpoint when the
 * user toggles localDns on, or after a rename). Adds the VM to the tracked set
 * if missing. Safe to call when the VM isn't running — reconcile will skip it.
 */
export async function publishVm(name) {
  await ensureTracked(name);
}

/**
 * Drop the VM from the tracked set and remove its mDNS entry. Used by the config
 * endpoint when the user toggles localDns off, on rename (old name), and on delete.
 */
export async function unpublishVm(name) {
  await dropTracked(name);
}
