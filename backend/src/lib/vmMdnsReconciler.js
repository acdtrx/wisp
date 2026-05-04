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
 */
import {
  subscribeVMNetworkChange,
  getCachedLocalDns,
  getGuestNetwork,
} from './vmManager/index.js';
import { deregisterAddress, registerAddress, sanitizeHostname } from './mdns/index.js';

const registered = new Set();

let logger = null;
let unsubscribe = null;

function log() {
  return logger || console;
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

  // Running, localDns=true. Publish if we have an IP. If not, leave any prior
  // entry alone — it stays valid until lifecycle says otherwise (matches the
  // pre-event publisher behavior).
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
    onNetworkChange(name, snapshot).catch((err) => {
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
export async function publishVm(name) {
  const { ip, hostname } = await getGuestNetwork(name);
  if (!ip) return;
  await registerAddress(name, hostname || sanitizeHostname(name), ip);
  registered.add(name);
}

/**
 * Drop the VM's mDNS entry. Used by the config endpoint when the user toggles
 * localDns off, on rename (old name), and on delete.
 */
export async function unpublishVm(name) {
  await deregisterAddress(name);
  registered.delete(name);
}
