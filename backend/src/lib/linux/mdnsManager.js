/**
 * Avahi-backed mDNS registration for VM/container addresses (Linux).
 * Best-effort only: failures never break VM/container operations.
 */
import dbus from 'dbus-next';

import { sanitizeHostname, stripCidr } from '../mdnsHostname.js';

const AVAHI_BUS_NAME = 'org.freedesktop.Avahi';
const AVAHI_SERVER_PATH = '/';
const AVAHI_SERVER_IFACE = 'org.freedesktop.Avahi.Server';
const AVAHI_GROUP_IFACE = 'org.freedesktop.Avahi.EntryGroup';
const AVAHI_IF_UNSPEC = -1;
const AVAHI_PROTO_UNSPEC = -1;
const AVAHI_FLAG_DEFAULT = 0;

const state = {
  bus: null,
  server: null,
  connected: false,
  /** key -> { group: EntryGroup iface, host: string, ip: string, fqdn: string } */
  entries: new Map(),
};

async function ensureConnected() {
  if (state.connected && state.server) return true;
  try {
    if (!state.bus) state.bus = dbus.systemBus();
    const obj = await state.bus.getProxyObject(AVAHI_BUS_NAME, AVAHI_SERVER_PATH);
    state.server = obj.getInterface(AVAHI_SERVER_IFACE);
    state.connected = true;
    return true;
  } catch (err) {
    console.warn('[mdns] Avahi connection failed:', err?.message || err);
    state.connected = false;
    state.server = null;
    return false;
  }
}

async function createGroup() {
  const groupPath = await state.server.EntryGroupNew();
  const obj = await state.bus.getProxyObject(AVAHI_BUS_NAME, groupPath);
  return obj.getInterface(AVAHI_GROUP_IFACE);
}

export async function connect() {
  await ensureConnected();
}

export async function disconnect() {
  for (const entry of state.entries.values()) {
    try {
      await entry.group.Free();
    } catch {
      /* best effort on shutdown */
    }
  }
  state.entries.clear();
  if (state.bus) {
    try {
      state.bus.disconnect();
    } catch {
      /* best effort */
    }
  }
  state.bus = null;
  state.server = null;
  state.connected = false;
}

export async function registerAddress(key, preferredName, ipOrCidr) {
  const ip = stripCidr(ipOrCidr);
  const host = sanitizeHostname(preferredName);
  if (!key || !host || !ip) return null;
  if (!(await ensureConnected())) return null;

  const current = state.entries.get(key);
  if (current && current.host === host && current.ip === ip) return current.fqdn;
  if (current) {
    try {
      await current.group.Free();
    } catch {
      /* free stale entry */
    }
    state.entries.delete(key);
  }

  try {
    const group = await createGroup();
    const fqdn = `${host}.local`;
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
    return null;
  }
}

export async function deregisterAddress(key) {
  const current = state.entries.get(key);
  if (!current) return;
  state.entries.delete(key);
  try {
    await current.group.Free();
  } catch {
    /* best effort */
  }
}

export function getRegisteredHostname(key) {
  return state.entries.get(key)?.fqdn || null;
}
