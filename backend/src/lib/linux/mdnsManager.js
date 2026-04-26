/**
 * Avahi-backed mDNS for Wisp (Linux):
 *   - publishes <container>.local on the LAN via avahi's EntryGroup API
 *   - exposes resolveLocalName/resolveLocalAddress helpers for mdnsForwarder,
 *     which answers container DNS queries from 169.254.53.53
 *
 * Single shared system-bus connection (opened once, watched for avahi restarts
 * via NameOwnerChanged). When avahi-daemon goes away and comes back, every
 * registered entry is re-added — without this, `systemctl restart avahi-daemon`
 * silently drops every container publication until wisp-backend restarts.
 *
 * All avahi calls are best-effort: failures never break VM/container ops.
 */
import dbus from 'dbus-next';

import { sanitizeHostname, stripCidr } from '../mdnsHostname.js';
import { startForwarder, stopForwarder } from './mdnsForwarder.js';

const AVAHI_BUS_NAME = 'org.freedesktop.Avahi';
const AVAHI_SERVER_PATH = '/';
const AVAHI_SERVER_IFACE = 'org.freedesktop.Avahi.Server';
const AVAHI_GROUP_IFACE = 'org.freedesktop.Avahi.EntryGroup';
const AVAHI_IF_UNSPEC = -1;
const AVAHI_PROTO_UNSPEC = -1;
const AVAHI_PROTO_INET = 0;
const AVAHI_PROTO_INET6 = 1;
const AVAHI_FLAG_DEFAULT = 0;

const state = {
  bus: null,
  server: null,
  /** key -> { group: EntryGroup iface | null, host, ip, fqdn } */
  entries: new Map(),
  /** serviceKey -> { group: EntryGroup iface | null, instanceName, type, port, txt, host } */
  services: new Map(),
  watchInstalled: false,
};

async function ensureBus() {
  if (state.bus) return state.bus;
  state.bus = dbus.systemBus();
  state.bus.on('error', (err) => {
    console.warn('[mdns] system bus error:', err?.message || err);
    state.server = null;
  });
  return state.bus;
}

async function installAvahiWatch() {
  if (state.watchInstalled) return;
  try {
    const bus = await ensureBus();
    await bus.addMatch(
      "type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='org.freedesktop.Avahi'",
    );
    const dbusObj = await bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus');
    const dbusIface = dbusObj.getInterface('org.freedesktop.DBus');
    dbusIface.on('NameOwnerChanged', (name, oldOwner, newOwner) => {
      if (name !== AVAHI_BUS_NAME) return;
      if (oldOwner && !newOwner) {
        console.warn('[mdns] avahi-daemon went away; entries will be re-registered when it returns');
        state.server = null;
        for (const entry of state.entries.values()) entry.group = null;
        for (const svc of state.services.values()) svc.group = null;
      } else if (!oldOwner && newOwner) {
        console.info('[mdns] avahi-daemon appeared; re-registering entries');
        reregisterAll().catch((err) => console.warn('[mdns] re-register failed:', err?.message || err));
      }
    });
    state.watchInstalled = true;
  } catch (err) {
    console.warn('[mdns] failed to install avahi watch:', err?.message || err);
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
}

export async function connect(logger = null) {
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
  if (state.bus) {
    try { state.bus.disconnect(); } catch { /* best effort */ }
  }
  state.bus = null;
  state.server = null;
  state.watchInstalled = false;
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
    console.warn('[mdns] registerAddress failed:', err?.message || err);
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
    console.warn('[mdns] registerService failed:', err?.message || err);
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
 * Look up a Wisp-published `.local` name in our own in-memory state.
 *
 * Used by mdnsForwarder for a fast path that avoids DBus + avahi entirely
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
 * Used by mdnsForwarder to answer container DNS queries without going through
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
