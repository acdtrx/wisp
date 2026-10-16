/**
 * Container mDNS reconciler — Wisp-glue between containerManager and the mDNS
 * module. Subscribe-only: containerManager fires `subscribeContainerNetworkChange`
 * whenever a container's `(state, ip, ip6)` differs from the last emitted
 * snapshot, including DHCP renewals and SLAAC changes (containerManager owns
 * the periodic netns probe and persists the new addresses into container.json
 * before firing). Both families are published under one `<name>.local` entry —
 * a dual-stack resolver that gets no AAAA answer stalls for its full local
 * timeout (~5s on macOS), so the AAAA rides along whenever the netns has a
 * global IPv6.
 *
 * Mirrors `vmMdnsReconciler.js` — same single-flat-file shape, no platform
 * split, no own polling, no own writes. Routes call `publishContainer` /
 * `unpublishContainer` directly when `localDns` toggles, on rename, and on
 * delete (those are metadata flips, not network changes).
 *
 * Every operation for one container — event handling and the route calls —
 * runs on that container's promise chain, one at a time in arrival order.
 * Each handler awaits a config read before it acts, so without the chain a
 * "running" handler still reading could register after a later "stopped"
 * handler had already found nothing to deregister, leaving a stopped
 * container published.
 *
 * Also re-publishes entry groups left probing when Wisp deletes a container's
 * netns (and with it a veth avahi was probing on) — see republishProbingGroups
 * in the mdns module for the avahi bug. Not on any container's chain: it acts
 * on every Wisp group, and must run right after the removal.
 */
import {
  subscribeContainerNetworkChange,
  subscribeContainerNetnsRemoved,
  getContainerConfig,
} from './containerManager/index.js';
import {
  deregisterAddress, registerAddress, republishProbingGroups, sanitizeHostname,
} from './mdns/index.js';

const registered = new Set();
/** name → tail of that container's operation chain */
const chains = new Map();

let logger = null;
let unsubscribe = null;
let unsubscribeNetnsRemoved = null;

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

  if (!snapshot.ip && !snapshot.ip6) return; // no address yet; leave any prior entry alone
  try {
    await registerAddress(name, sanitizeHostname(name), snapshot.ip, snapshot.ip6);
    registered.add(name);
  } catch (err) {
    log().warn?.({ err: err?.message || err, container: name, ip: snapshot.ip, ip6: snapshot.ip6 }, '[containerMdns] register failed');
  }
}

export function startContainerMdnsReconciler(log_) {
  if (unsubscribe) return; // already started
  logger = log_ || null;
  unsubscribe = subscribeContainerNetworkChange((name, snapshot) => {
    enqueue(name, () => onNetworkChange(name, snapshot)).catch((err) => {
      log().warn?.({ err: err?.message || err, container: name }, '[containerMdns] handler threw');
    });
  });
  unsubscribeNetnsRemoved = subscribeContainerNetnsRemoved((name) => {
    republishProbingGroups({ event: 'container-netns-removed', container: name });
  });
}

export function stopContainerMdnsReconciler() {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (unsubscribeNetnsRemoved) {
    unsubscribeNetnsRemoved();
    unsubscribeNetnsRemoved = null;
  }
  registered.clear();
}

/**
 * Force a publish attempt for a single container (called by routes when the
 * user toggles localDns on, or after a rename). Publishes only a running
 * container with `localDns: true` — container.json keeps the last addresses
 * after a stop, so they alone don't mean the container is reachable there.
 * A no-op otherwise; the network-change event publishes it once it runs.
 */
export function publishContainer(name) {
  return enqueue(name, async () => {
    let config;
    try { config = await getContainerConfig(name); }
    catch { return; }
    if (config?.localDns !== true || config.state !== 'running') return;
    const ip = config.network?.ip;
    const ip6 = config.network?.ip6;
    if (!ip && !ip6) return;
    await registerAddress(name, sanitizeHostname(name), ip, ip6);
    registered.add(name);
  });
}

/**
 * Drop the container's mDNS entry. Used by routes when the user toggles
 * localDns off, on rename (old name), and before delete.
 */
export function unpublishContainer(name) {
  return enqueue(name, async () => {
    await deregisterAddress(name);
    registered.delete(name);
  });
}
