/**
 * Avahi-backed mDNS for Wisp (Linux):
 *   - publishes <container>.local on the LAN via avahi's EntryGroup API
 *   - browses LAN services by type via avahi's ServiceBrowser API
 *     (subscribeServiceBrowse), resolving each hit to host/port/TXT
 *   - exposes resolveLocalName/resolveLocalAddress helpers for forwarder.js,
 *     which answers container DNS queries from 169.254.53.53
 *
 * Single shared system-bus connection (opened once, watched for avahi restarts
 * via NameOwnerChanged). When avahi-daemon goes away and comes back, every
 * registered entry is re-added and every browser re-created — without this,
 * `systemctl restart avahi-daemon` silently drops every container publication
 * until wisp restarts.
 *
 * All avahi calls are best-effort: failures never break VM/container ops.
 */
import dbus from 'dbus-next';

import { sanitizeHostname, stripCidr } from '../hostname.js';
import { startForwarder, stopForwarder } from './forwarder.js';

const AVAHI_BUS_NAME = 'org.freedesktop.Avahi';
const AVAHI_SERVER_PATH = '/';
const AVAHI_SERVER_IFACE = 'org.freedesktop.Avahi.Server';
const AVAHI_GROUP_IFACE = 'org.freedesktop.Avahi.EntryGroup';
const AVAHI_BROWSER_IFACE = 'org.freedesktop.Avahi.ServiceBrowser';
const AVAHI_RESOLVER_IFACE = 'org.freedesktop.Avahi.ServiceResolver';
const AVAHI_IF_UNSPEC = -1;
const AVAHI_PROTO_UNSPEC = -1;
const AVAHI_PROTO_INET = 0;
const AVAHI_PROTO_INET6 = 1;
const AVAHI_FLAG_DEFAULT = 0;
// Lookup-result bits on resolved/browsed records. Kept private — the browse
// surface normalizes them into `svc.isLocal` so callers never see wire flags.
const AVAHI_LOOKUP_RESULT_LOCAL = 8;
const AVAHI_LOOKUP_RESULT_OUR_OWN = 16;

const state = {
  bus: null,
  server: null,
  /** key -> { group: EntryGroup iface | null, host, ip, fqdn } */
  entries: new Map(),
  /** serviceKey -> { group: EntryGroup iface | null, instanceName, type, port, txt, host } */
  services: new Map(),
  /** type -> { type, path, starting, sightings, resolved, resolvers, subscribers } */
  browses: new Map(),
  /** browser object path -> browse record (signal dispatch index) */
  browsePaths: new Map(),
  /** resolver object path -> { record, name } (signal dispatch index) */
  resolverPaths: new Map(),
  /** path -> signals that arrived before the *New call resolved to that path */
  pendingBrowseSignals: new Map(),
  browseCreationsInFlight: 0,
  browseDispatchInstalled: false,
  watchInstalled: false,
  /** Pino-compatible logger plumbed via connect(); falls back to console for boot-time paths. */
  logger: null,
};

async function ensureBus() {
  if (state.bus) return state.bus;
  state.bus = dbus.systemBus();
  state.bus.on('error', (err) => {
    state.logger?.warn?.({ err: err?.message || err }, '[mdns] system bus error');
    state.server = null;
  });
  return state.bus;
}

async function installAvahiWatch() {
  if (state.watchInstalled) return;
  try {
    const bus = await ensureBus();
    const dbusObj = await bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus');
    const dbusIface = dbusObj.getInterface('org.freedesktop.DBus');
    // dbus-next auto-installs the match rule when we attach a listener on the proxy
    // iface (see proxy-interface.js _addMatch in dbus-next), so no explicit AddMatch
    // call is needed. We filter by name in the handler — system-bus NameOwnerChanged
    // churn is low.
    dbusIface.on('NameOwnerChanged', (name, oldOwner, newOwner) => {
      if (name !== AVAHI_BUS_NAME) return;
      if (oldOwner && !newOwner) {
        state.logger?.warn?.('[mdns] avahi-daemon went away; entries will be re-registered when it returns');
        state.server = null;
        for (const entry of state.entries.values()) entry.group = null;
        for (const svc of state.services.values()) svc.group = null;
        for (const record of state.browses.values()) resetBrowseRecord(record);
        state.pendingBrowseSignals.clear();
      } else if (!oldOwner && newOwner) {
        state.logger?.info?.('[mdns] avahi-daemon appeared; re-registering entries');
        reregisterAll().catch((err) =>
          state.logger?.warn?.({ err: err?.message || err }, '[mdns] re-register failed'),
        );
      }
    });
    state.watchInstalled = true;
  } catch (err) {
    state.logger?.warn?.({ err: err?.message || err }, '[mdns] failed to install avahi watch');
  }
}

async function ensureServer() {
  if (state.server) return state.server;
  try {
    const bus = await ensureBus();
    const obj = await bus.getProxyObject(AVAHI_BUS_NAME, AVAHI_SERVER_PATH);
    state.server = obj.getInterface(AVAHI_SERVER_IFACE);
    return state.server;
  } catch {
    state.server = null;
    return null;
  }
}

async function createGroup() {
  const server = await ensureServer();
  if (!server) return null;
  const groupPath = await server.EntryGroupNew();
  const obj = await state.bus.getProxyObject(AVAHI_BUS_NAME, groupPath);
  return obj.getInterface(AVAHI_GROUP_IFACE);
}

async function reregisterAll() {
  const storedAddresses = [];
  for (const [key, entry] of state.entries.entries()) {
    storedAddresses.push({ key, host: entry.host, ip: entry.ip });
  }
  state.entries.clear();
  for (const { key, host, ip } of storedAddresses) {
    await registerAddress(key, host, ip);
  }
  const storedServices = [];
  for (const [serviceKey, svc] of state.services.entries()) {
    storedServices.push({
      serviceKey,
      instanceName: svc.instanceName,
      type: svc.type,
      port: svc.port,
      txt: svc.txt,
      host: svc.host,
    });
  }
  state.services.clear();
  for (const s of storedServices) {
    await registerService(s.serviceKey, s.instanceName, s.type, s.port, s.txt, s.host);
  }
  for (const record of state.browses.values()) {
    await startBrowse(record);
  }
}

export async function connect(logger = null) {
  state.logger = logger;
  await ensureBus();
  await installAvahiWatch();
  await ensureServer();
  await startForwarder(logger);
}

export async function disconnect() {
  await stopForwarder();
  for (const entry of state.entries.values()) {
    if (!entry.group) continue;
    try { await entry.group.Free(); } catch { /* best effort on shutdown */ }
  }
  state.entries.clear();
  for (const svc of state.services.values()) {
    if (!svc.group) continue;
    try { await svc.group.Free(); } catch { /* best effort on shutdown */ }
  }
  state.services.clear();
  for (const record of state.browses.values()) {
    for (const name of [...record.resolvers.keys()]) {
      freeResolverForName(record, name);
    }
    const path = record.path;
    record.path = null;
    if (path) await freeBrowserPath(path);
  }
  state.browses.clear();
  state.browsePaths.clear();
  state.resolverPaths.clear();
  state.pendingBrowseSignals.clear();
  if (state.bus) {
    try { state.bus.disconnect(); } catch { /* best effort */ }
  }
  state.bus = null;
  state.server = null;
  state.watchInstalled = false;
  state.browseDispatchInstalled = false;
}

export async function registerAddress(key, preferredName, ipOrCidr) {
  const ip = stripCidr(ipOrCidr);
  const host = sanitizeHostname(preferredName);
  if (!key || !host || !ip) return null;

  const current = state.entries.get(key);
  if (current && current.group && current.host === host && current.ip === ip) {
    return current.fqdn;
  }
  if (current && current.group) {
    try { await current.group.Free(); } catch { /* free stale */ }
  }
  state.entries.delete(key);

  const fqdn = `${host}.local`;
  try {
    const group = await createGroup();
    if (!group) {
      // avahi unavailable — keep the entry so NameOwnerChanged re-registers it
      state.entries.set(key, { group: null, host, ip, fqdn });
      return null;
    }
    await group.AddAddress(
      AVAHI_IF_UNSPEC,
      AVAHI_PROTO_UNSPEC,
      AVAHI_FLAG_DEFAULT,
      fqdn,
      ip,
    );
    await group.Commit();
    state.entries.set(key, { group, host, ip, fqdn });
    return fqdn;
  } catch (err) {
    state.logger?.warn?.({ err: err?.message || err, host, ip }, '[mdns] registerAddress failed');
    state.entries.set(key, { group: null, host, ip, fqdn });
    return null;
  }
}

export async function deregisterAddress(key) {
  const current = state.entries.get(key);
  if (!current) return;
  state.entries.delete(key);
  if (current.group) {
    try { await current.group.Free(); } catch { /* best effort */ }
  }
}

export function getRegisteredHostname(key) {
  return state.entries.get(key)?.fqdn || null;
}

function txtMapToAvahi(txt) {
  if (!txt || typeof txt !== 'object') return [];
  const out = [];
  for (const [k, v] of Object.entries(txt)) {
    if (!k) continue;
    out.push(Buffer.from(`${k}=${v == null ? '' : String(v)}`, 'utf8'));
  }
  return out;
}

/**
 * Publish an mDNS service (SRV+TXT) for a host already published via registerAddress.
 *
 * @param {string} serviceKey  unique key (we use `${containerName}#${port}`)
 * @param {string} instanceName  service instance name (defaults to host on collision)
 * @param {string} type  e.g. "_smb._tcp"
 * @param {number} port  1..65535
 * @param {object} txt  flat key/value map (values stringified)
 * @param {string} host  FQDN the SRV target points at, e.g. "mycontainer.local"
 * @returns {Promise<boolean>}  true on success, false on best-effort failure
 */
export async function registerService(serviceKey, instanceName, type, port, txt, host) {
  if (!serviceKey || !instanceName || !type || !host) return false;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;

  const txtPairs = txtMapToAvahi(txt);
  const current = state.services.get(serviceKey);
  if (current && current.group) {
    try { await current.group.Free(); } catch { /* free stale */ }
  }
  state.services.delete(serviceKey);

  try {
    const group = await createGroup();
    if (!group) {
      // avahi unavailable — keep entry so NameOwnerChanged re-registers it
      state.services.set(serviceKey, { group: null, instanceName, type, port, txt, host });
      return false;
    }
    await group.AddService(
      AVAHI_IF_UNSPEC,
      AVAHI_PROTO_UNSPEC,
      AVAHI_FLAG_DEFAULT,
      instanceName,
      type,
      '',          // domain — empty = .local
      host,        // SRV target host (must be a name avahi or another stack publishes)
      port,
      txtPairs,
    );
    await group.Commit();
    state.services.set(serviceKey, { group, instanceName, type, port, txt, host });
    return true;
  } catch (err) {
    state.logger?.warn?.({ err: err?.message || err, instanceName, type, port }, '[mdns] registerService failed');
    state.services.set(serviceKey, { group: null, instanceName, type, port, txt, host });
    return false;
  }
}

export async function deregisterService(serviceKey) {
  const current = state.services.get(serviceKey);
  if (!current) return;
  state.services.delete(serviceKey);
  if (current.group) {
    try { await current.group.Free(); } catch { /* best effort */ }
  }
}

/**
 * Deregister every service tied to a container — used by stop/kill/delete and the
 * localDns toggle so callers do not have to remember per-port keys.
 */
export async function deregisterServicesForContainer(containerName) {
  if (!containerName) return;
  const prefix = `${containerName}#`;
  const matched = [];
  for (const key of state.services.keys()) {
    if (key.startsWith(prefix)) matched.push(key);
  }
  for (const key of matched) {
    await deregisterService(key);
  }
}

/**
 * Decode avahi TXT records (array of `k=v` byte buffers) into a flat map.
 * Entries without `=` become { key: '' }.
 */
function txtMapFromAvahi(txtPairs) {
  const txt = {};
  for (const raw of txtPairs || []) {
    let s;
    try { s = Buffer.from(raw).toString('utf8'); } catch { continue; /* skip undecodable entry */ }
    if (!s) continue;
    const eq = s.indexOf('=');
    if (eq === -1) txt[s] = '';
    else txt[s.slice(0, eq)] = s.slice(eq + 1);
  }
  return txt;
}

/**
 * Free an avahi signal object (browser/resolver) by path with a raw method
 * call — no proxy introspection needed (the object may already be half-dead).
 */
async function freeAvahiPath(path, iface) {
  if (!path || !state.bus) return;
  try {
    await state.bus.call(new dbus.Message({
      destination: AVAHI_BUS_NAME,
      path,
      interface: iface,
      member: 'Free',
    }));
  } catch { /* best effort — avahi may be gone */ }
}

async function freeBrowserPath(path) {
  state.browsePaths.delete(path);
  await freeAvahiPath(path, AVAHI_BROWSER_IFACE);
}

function freeResolverForName(record, name) {
  const path = record.resolvers.get(name);
  record.resolvers.delete(name);
  // Entries hold a reservation token (symbol) while ServiceResolverNew is in
  // flight — only real object paths (strings) exist on the bus to be freed.
  if (typeof path === 'string') {
    state.resolverPaths.delete(path);
    freeAvahiPath(path, AVAHI_RESOLVER_IFACE);
  }
}

/**
 * Drop a browser's runtime state (path registration, sightings, resolvers,
 * resolved services) and tell subscribers to start over. Used when avahi
 * goes away and on browser Failure signals.
 */
function resetBrowseRecord(record) {
  if (record.path) {
    state.browsePaths.delete(record.path);
    record.path = null;
  }
  for (const name of [...record.resolvers.keys()]) {
    freeResolverForName(record, name);
  }
  record.sightings.clear();
  record.resolved.clear();
  notifyBrowseSubscribers(record, 'onReset');
}

function invokeBrowseHandler(record, handlers, event, arg) {
  try {
    handlers[event]?.(arg);
  } catch (err) {
    state.logger?.warn?.({ err: err?.message || err, type: record.type }, '[mdns] browse subscriber threw');
  }
}

function notifyBrowseSubscribers(record, event, arg) {
  for (const handlers of record.subscribers) {
    invokeBrowseHandler(record, handlers, event, arg);
  }
}

/**
 * Raw bus-level dispatch for ServiceBrowser/ServiceResolver signals. Avahi
 * starts emitting signals immediately after the *New method returns —
 * possibly in the same parsed socket batch as the method reply, before our
 * promise handler learns the object path. The proxy/getInterface idiom would
 * lose those, so we listen to every inbound message (dbus-next emits
 * bus 'message' before internal routing) and route by path; signals for a
 * path we don't know yet are buffered while a creation is in flight.
 */
function installBrowseDispatch() {
  if (state.browseDispatchInstalled || !state.bus) return;
  state.bus.on('message', (msg) => {
    const isBrowser = msg.interface === AVAHI_BROWSER_IFACE;
    const isResolver = msg.interface === AVAHI_RESOLVER_IFACE;
    if (!isBrowser && !isResolver) return;
    if (isBrowser) {
      const record = state.browsePaths.get(msg.path);
      if (record) {
        dispatchBrowseSignal(record, msg);
        return;
      }
    } else {
      const entry = state.resolverPaths.get(msg.path);
      if (entry) {
        dispatchResolverSignal(entry, msg);
        return;
      }
    }
    if (state.browseCreationsInFlight > 0) {
      let queue = state.pendingBrowseSignals.get(msg.path);
      if (!queue) {
        queue = [];
        state.pendingBrowseSignals.set(msg.path, queue);
      }
      if (queue.length < 100) queue.push(msg);
    }
  });
  state.browseDispatchInstalled = true;
}

function dispatchResolverSignal(entry, msg) {
  const body = msg.body || [];
  if (msg.member === 'Found') {
    onResolverFound(entry.record, entry.name, body);
  } else if (msg.member === 'Failure') {
    state.logger?.warn?.(
      { err: body[0], name: entry.name, type: entry.record.type },
      '[mdns] service resolver failed',
    );
    onResolverFailure(entry.record, entry.name, msg.path);
  }
}

/**
 * Persistent-resolver result. Avahi re-emits Found whenever the service's
 * records change (TXT/SRV/A updates), so onUp fires again with fresh data —
 * this is how a peer's advertised URL change propagates without re-announce
 * tricks or polling.
 */
function onResolverFound(record, name, body) {
  // [interface, protocol, name, type, domain, host, aprotocol, address, port, txt, flags]
  const flags = Number(body[10]) || 0;
  const svc = {
    name,
    type: record.type,
    host: String(body[5] || '').replace(/\.$/, ''),
    address: body[7] || null,
    port: Number(body[8]) || 0,
    txt: txtMapFromAvahi(body[9]),
    isLocal: (flags & (AVAHI_LOOKUP_RESULT_LOCAL | AVAHI_LOOKUP_RESULT_OUR_OWN)) !== 0,
  };
  const prev = record.resolved.get(name);
  if (prev && JSON.stringify(prev) === JSON.stringify(svc)) return; // per-interface duplicate
  record.resolved.set(name, svc);
  notifyBrowseSubscribers(record, 'onUp', svc);
}

function onResolverFailure(record, name, path) {
  state.resolverPaths.delete(path);
  freeAvahiPath(path, AVAHI_RESOLVER_IFACE);
  // A later ItemNew sighting re-creates the resolver.
  if (record.resolvers.get(name) === path) record.resolvers.delete(name);
  if (record.resolved.delete(name)) notifyBrowseSubscribers(record, 'onDown', name);
}

function dispatchBrowseSignal(record, msg) {
  const body = msg.body || [];
  if (msg.member === 'ItemNew') {
    // (interface, protocol, name, type, domain, flags)
    onBrowseItemNew(record, body[0], body[1], body[2], body[4]).catch((err) =>
      state.logger?.warn?.({ err: err?.message || err, type: record.type }, '[mdns] browse ItemNew failed'),
    );
  } else if (msg.member === 'ItemRemove') {
    onBrowseItemRemove(record, body[0], body[1], body[2]);
  } else if (msg.member === 'Failure') {
    state.logger?.warn?.({ err: body[0], type: record.type }, '[mdns] service browser failed; recreating');
    const failedPath = record.path;
    resetBrowseRecord(record);
    if (failedPath) freeBrowserPath(failedPath); // avahi objects count against a per-client cap
    startBrowse(record);
  }
  // AllForNow / CacheExhausted are irrelevant to a continuous browse
}

async function onBrowseItemNew(record, iface, proto, name, domain) {
  const pairKey = `${iface}/${proto}`;
  let pairs = record.sightings.get(name);
  if (!pairs) {
    pairs = new Set();
    record.sightings.set(name, pairs);
  }
  if (pairs.has(pairKey)) return;
  pairs.add(pairKey);

  // One PERSISTENT resolver per instance name (extra sightings on other
  // interfaces/protocols only feed the removal refcount). A persistent
  // ServiceResolver keeps emitting Found when the peer's records change —
  // one-shot ResolveService would freeze the first TXT forever, because a
  // same-name re-registration updates records in place without any
  // ItemRemove/ItemNew on remote browsers.
  if (record.resolvers.has(name)) return;
  // Reserve with a per-call token: overlapping create/remove/create cycles for
  // the same name (interface flap) must not let an older call adopt or clean
  // up a newer call's reservation — a null placeholder can't tell them apart.
  const token = Symbol('resolver-pending');
  record.resolvers.set(name, token);
  let path = null;
  let pending = null;
  try {
    const server = await ensureServer();
    if (!server) {
      if (record.resolvers.get(name) === token) record.resolvers.delete(name);
      return;
    }
    state.browseCreationsInFlight += 1;
    try {
      path = await server.ServiceResolverNew(
        AVAHI_IF_UNSPEC, AVAHI_PROTO_UNSPEC, name, record.type, domain,
        AVAHI_PROTO_UNSPEC, AVAHI_FLAG_DEFAULT,
      );
      if (record.resolvers.get(name) !== token) {
        // service vanished, record reset, or a newer call took over while
        // this one was in flight — this path is ours alone to free
        await freeAvahiPath(path, AVAHI_RESOLVER_IFACE);
        return;
      }
      record.resolvers.set(name, path);
      state.resolverPaths.set(path, { record, name });
      pending = state.pendingBrowseSignals.get(path) || null;
      if (pending) state.pendingBrowseSignals.delete(path);
    } finally {
      state.browseCreationsInFlight -= 1;
      if (state.browseCreationsInFlight === 0) state.pendingBrowseSignals.clear();
    }
  } catch (err) {
    if (record.resolvers.get(name) === token) record.resolvers.delete(name);
    // A later ItemNew sighting (another iface/proto or re-announce) retries.
    state.logger?.warn?.({ err: err?.message || err, name, type: record.type }, '[mdns] ServiceResolverNew failed');
    return;
  }
  // Drain outside the try so a throwing handler can't be mistaken for a
  // failed ServiceResolverNew call. Stop if a replayed Failure freed us.
  if (pending) {
    for (const msg of pending) {
      if (record.resolvers.get(name) !== path) break;
      dispatchResolverSignal({ record, name }, msg);
    }
  }
}

function onBrowseItemRemove(record, iface, proto, name) {
  const pairs = record.sightings.get(name);
  if (!pairs) return;
  pairs.delete(`${iface}/${proto}`);
  if (pairs.size > 0) return;
  record.sightings.delete(name);
  freeResolverForName(record, name);
  const hadResolved = record.resolved.delete(name);
  if (hadResolved) notifyBrowseSubscribers(record, 'onDown', name);
}

async function startBrowse(record) {
  if (record.path || record.starting) return;
  record.starting = true;
  let pending = null;
  try {
    const server = await ensureServer();
    if (!server) return; // record stays pathless; re-created when avahi appears
    installBrowseDispatch();
    state.browseCreationsInFlight += 1;
    try {
      const path = await server.ServiceBrowserNew(
        AVAHI_IF_UNSPEC, AVAHI_PROTO_UNSPEC, record.type, '', AVAHI_FLAG_DEFAULT,
      );
      if (record.subscribers.size === 0) {
        // everyone unsubscribed while the call was in flight
        await freeBrowserPath(path);
        return;
      }
      record.path = path;
      state.browsePaths.set(path, record);
      pending = state.pendingBrowseSignals.get(path) || null;
      if (pending) state.pendingBrowseSignals.delete(path);
    } finally {
      state.browseCreationsInFlight -= 1;
      if (state.browseCreationsInFlight === 0) state.pendingBrowseSignals.clear();
    }
  } catch (err) {
    state.logger?.warn?.({ err: err?.message || err, type: record.type }, '[mdns] ServiceBrowserNew failed');
  } finally {
    record.starting = false;
  }
  // Replay buffered signals only after `starting` clears: a buffered Failure
  // resets the record and re-invokes startBrowse, which must not see itself
  // as still in flight. Stop if a replayed signal reset the record.
  if (pending) {
    for (const msg of pending) {
      if (!record.path) break;
      dispatchBrowseSignal(record, msg);
    }
  }
}

/**
 * Browse the LAN for services of `type` (e.g. "_wisp._tcp").
 *
 * handlers:
 *   onUp(svc)     service resolved — { name, type, host, address, port, txt, isLocal }
 *                 (isLocal: announced by this host or this connection — for
 *                 self-filtering). Fires AGAIN with fresh data whenever the
 *                 service's records change (persistent resolver per service).
 *   onDown(name)  service gone from every interface/protocol
 *   onReset()     browser lost (avahi restart/failure) — drop all known services
 *
 * Already-resolved services are replayed via onUp before this returns.
 * Returns an unsubscribe function; the underlying browser is freed when the
 * last subscriber leaves. Best-effort: on darwin or without avahi, no events.
 */
export function subscribeServiceBrowse(type, handlers) {
  if (!type || !handlers) return () => {};
  let record = state.browses.get(type);
  if (!record) {
    record = {
      type,
      path: null,
      starting: false,
      /** name -> Set<'iface/proto'> sightings (dedup + removal refcount) */
      sightings: new Map(),
      /** name -> resolved svc */
      resolved: new Map(),
      /** name -> persistent ServiceResolver path (null while creating) */
      resolvers: new Map(),
      subscribers: new Set(),
    };
    state.browses.set(type, record);
  }
  record.subscribers.add(handlers);
  for (const svc of record.resolved.values()) {
    invokeBrowseHandler(record, handlers, 'onUp', svc);
  }
  startBrowse(record);
  return () => {
    record.subscribers.delete(handlers);
    if (record.subscribers.size > 0) return;
    state.browses.delete(type);
    for (const name of [...record.resolvers.keys()]) {
      freeResolverForName(record, name);
    }
    const path = record.path;
    record.path = null;
    if (path) freeBrowserPath(path);
  };
}

/**
 * Look up a Wisp-published `.local` name in our own in-memory state.
 *
 * Used by forwarder.js for a fast path that avoids DBus + avahi entirely
 * for names we know we own. Returns the address and its family (inferred
 * from the literal — `:` → inet6, else inet), or null if the name is not
 * published by this Wisp instance.
 *
 * @param {string} fqdn FQDN (trailing dot tolerated, case-insensitive).
 * @returns {{address: string, family: 'inet'|'inet6'} | null}
 */
export function lookupLocalEntry(fqdn) {
  const clean = String(fqdn || '').toLowerCase().replace(/\.$/, '');
  if (!clean) return null;
  for (const entry of state.entries.values()) {
    if (entry.fqdn === clean) {
      return {
        address: entry.ip,
        family: entry.ip.includes(':') ? 'inet6' : 'inet',
      };
    }
  }
  return null;
}

/**
 * Resolve a `.local` name → IP via avahi's DBus API.
 *
 * Used by forwarder.js to answer container DNS queries without going through
 * multicast (avahi returns its own published records for DBus callers, so
 * same-host container→container resolution works — no multicast loop-prevention
 * edge case). Returns null on any failure (name not found, avahi unavailable).
 *
 * @param {string} name FQDN like "foo.local" (trailing dot tolerated).
 * @param {'inet'|'inet6'|'any'} family Preferred address family.
 * @returns {Promise<{address: string, family: 'inet'|'inet6'} | null>}
 */
export async function resolveLocalName(name, family = 'any') {
  const server = await ensureServer();
  if (!server) return null;
  const aproto =
    family === 'inet' ? AVAHI_PROTO_INET :
    family === 'inet6' ? AVAHI_PROTO_INET6 :
    AVAHI_PROTO_UNSPEC;
  const cleaned = String(name || '').replace(/\.$/, '');
  if (!cleaned) return null;
  try {
    const out = await server.ResolveHostName(
      AVAHI_IF_UNSPEC, AVAHI_PROTO_UNSPEC, cleaned, aproto, AVAHI_FLAG_DEFAULT,
    );
    // [interface, protocol, name, aprotocol, address, flags]
    const aprotocol = out[3];
    const address = out[4];
    if (!address) return null;
    return { address, family: aprotocol === AVAHI_PROTO_INET6 ? 'inet6' : 'inet' };
  } catch {
    return null;
  }
}

/**
 * Reverse-resolve an IP via avahi. Returns a hostname (e.g. "foo.local") or null.
 */
export async function resolveLocalAddress(ip) {
  const server = await ensureServer();
  if (!server) return null;
  try {
    const out = await server.ResolveAddress(
      AVAHI_IF_UNSPEC, AVAHI_PROTO_UNSPEC, ip, AVAHI_FLAG_DEFAULT,
    );
    // [interface, protocol, aprotocol, address, name, flags]
    return out[4] || null;
  } catch {
    return null;
  }
}
