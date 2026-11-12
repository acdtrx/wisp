/**
 * VM mDNS reconciler — Wisp-glue between vmManager and the mDNS module.
 *
 * Subscribes to `vmManager.subscribeVMNetworkChange` and registers/deregisters
 * Avahi A records for VMs whose Wisp metadata has `localDns: true`. All
 * libvirt/AgentEvent/safety-net plumbing lives inside vmManager — this file
 * carries no platform-specific code, so it stays a single flat module.
 *
 * Routes call `publishVm` / `unpublishVm` directly when the user toggles
 * `localDns`, renames a VM, or deletes one — those are metadata flips, not
 * network-state changes, so they bypass the event path.
 *
 * Every operation for one VM — event handling and the route calls — runs on
 * that VM's promise chain, one at a time in arrival order. A register awaits
 * avahi before it records the entry, so without the chain a stop arriving in
 * between found nothing to deregister and left a stopped VM published.
 *
 * A VM leaving the running state also re-publishes entry groups left probing:
 * libvirt has removed the VM's tap by the time the stop is reported, and
 * avahi 0.8 strands any group that was probing on it (see
 * republishProbingGroups in the mdns module). Not on any VM's chain: it acts
 * on every Wisp group, and must run right after the stop.
 */
import {
  subscribeVMNetworkChange,
  getCachedLocalDns,
  getGuestNetwork,
} from './vmManager/index.js';
import {
  deregisterAddress, registerAddress, republishProbingGroups, sanitizeHostname,
} from './mdns/index.js';

const registered = new Set();
/** name → tail of that VM's operation chain */
const chains = new Map();

let logger = null;
let unsubscribe = null;

function log() {
  return logger || console;
}

/**
 * Run `op` after every earlier operation for `name` has settled. Resolves or
 * rejects with `op`'s own outcome; a failure never blocks later operations.
 */
function enqueue(name, op) {
  const prev = chains.get(name) || Promise.resolve();
  const run = prev.then(op);
  const tail = run.catch(() => { /* surfaced to this op's caller; the chain continues */ });
  chains.set(name, tail);
  tail.then(() => {
    if (chains.get(name) === tail) chains.delete(name);
  });
  return run;
}

async function onNetworkChange(name, snapshot) {
  if (snapshot === null) {
    if (registered.has(name)) {
      try { await deregisterAddress(name); }
      catch (err) { log().warn?.({ err: err?.message || err, vm: name }, '[vmMdns] deregister on stop failed'); }
      registered.delete(name);
    }
    return;
  }

  const localDns = getCachedLocalDns(name);
  if (!localDns) {
    if (registered.has(name)) {
      try { await deregisterAddress(name); }
      catch (err) { log().warn?.({ err: err?.message || err, vm: name }, '[vmMdns] deregister on toggle-off failed'); }
      registered.delete(name);
    }
    return;
  }

  // Running, localDns=true. Publish if we have an IP. If not (agent briefly
  // unreachable), leave any prior entry alone — it stays valid until the VM
  // stops or localDns is turned off.
  if (!snapshot.ip) return;
  try {
    await registerAddress(name, snapshot.hostname || sanitizeHostname(name), snapshot.ip);
    registered.add(name);
  } catch (err) {
    log().warn?.({ err: err?.message || err, vm: name, ip: snapshot.ip }, '[vmMdns] register failed');
  }
}

export function startVmMdnsReconciler(log_) {
  if (unsubscribe) return; // already started
  logger = log_ || null;
  unsubscribe = subscribeVMNetworkChange((name, snapshot) => {
    if (snapshot === null) republishProbingGroups({ event: 'vm-stopped', vm: name });
    enqueue(name, () => onNetworkChange(name, snapshot)).catch((err) => {
      log().warn?.({ err: err?.message || err, vm: name }, '[vmMdns] handler threw');
    });
  });
}

export function stopVmMdnsReconciler() {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  registered.clear();
}

/**
 * Force a publish attempt for a single VM (called by the config endpoint when
 * the user toggles localDns on, or after a rename). Reads the current IP via
 * the public vmManager facade. Safe to call when the VM isn't running — there
 * just won't be an IP to register.
 */
export function publishVm(name) {
  return enqueue(name, async () => {
    const { ip, hostname } = await getGuestNetwork(name);
    if (!ip) return;
    await registerAddress(name, hostname || sanitizeHostname(name), ip);
    registered.add(name);
  });
}

/**
 * Drop the VM's mDNS entry. Used by the config endpoint when the user toggles
 * localDns off, on rename (old name), and on delete.
 */
export function unpublishVm(name) {
  return enqueue(name, async () => {
    await deregisterAddress(name);
    registered.delete(name);
  });
}
