/**
 * Container mDNS reconciler — Wisp-glue between containerManager and the mDNS
 * module. Subscribe-only: containerManager fires `subscribeContainerNetworkChange`
 * whenever a container's `(state, ip)` differs from the last emitted snapshot,
 * including DHCP renewals (containerManager owns the periodic netns probe and
 * persists the new IP into container.json before firing).
 *
 * Mirrors `vmMdnsReconciler.js` — same single-flat-file shape, no platform
 * split, no own polling, no own writes. Routes call `publishContainer` /
 * `unpublishContainer` directly when `localDns` toggles, on rename, and on
 * delete (those are metadata flips, not network changes).
 */
import {
  subscribeContainerNetworkChange,
  getContainerConfig,
} from './containerManager/index.js';
import { deregisterAddress, registerAddress, sanitizeHostname } from './mdns/index.js';

const registered = new Set();

let logger = null;
let unsubscribe = null;

function log() {
  return logger || console;
}

async function readLocalDns(name) {
  try {
    const cfg = await getContainerConfig(name);
    return cfg?.localDns === true;
  } catch {
    return false;
  }
}

async function onNetworkChange(name, snapshot) {
  if (snapshot === null) {
    if (registered.has(name)) {
      try { await deregisterAddress(name); }
      catch (err) { log().warn?.({ err: err?.message || err, container: name }, '[containerMdns] deregister on stop failed'); }
      registered.delete(name);
    }
    return;
  }

  const localDns = await readLocalDns(name);
  if (!localDns) {
    if (registered.has(name)) {
      try { await deregisterAddress(name); }
      catch (err) { log().warn?.({ err: err?.message || err, container: name }, '[containerMdns] deregister on toggle-off failed'); }
      registered.delete(name);
    }
    return;
  }

  if (!snapshot.ip) return; // no IP yet; leave any prior entry alone
  try {
    await registerAddress(name, sanitizeHostname(name), snapshot.ip);
    registered.add(name);
  } catch (err) {
    log().warn?.({ err: err?.message || err, container: name, ip: snapshot.ip }, '[containerMdns] register failed');
  }
}

export function startContainerMdnsReconciler(log_) {
  if (unsubscribe) return; // already started
  logger = log_ || null;
  unsubscribe = subscribeContainerNetworkChange((name, snapshot) => {
    onNetworkChange(name, snapshot).catch((err) => {
      log().warn?.({ err: err?.message || err, container: name }, '[containerMdns] handler threw');
    });
  });
}

export function stopContainerMdnsReconciler() {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  registered.clear();
}

/**
 * Force a publish attempt for a single container (called by routes when the
 * user toggles localDns on, or after a rename). Reads the current network
 * config via the public containerManager facade. Safe to call when the
 * container isn't running — there just won't be an IP to register.
 */
export async function publishContainer(name) {
  let config;
  try { config = await getContainerConfig(name); }
  catch { return; }
  const ip = config?.network?.ip;
  if (!ip) return;
  await registerAddress(name, sanitizeHostname(name), ip);
  registered.add(name);
}

/**
 * Drop the container's mDNS entry. Used by routes when the user toggles
 * localDns off, on rename (old name), and before delete.
 */
export async function unpublishContainer(name) {
  await deregisterAddress(name);
  registered.delete(name);
}
