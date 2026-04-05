/**
 * Libvirt DBus connection and domain access (Linux).
 */
import dbus from 'dbus-next';

import {
  vmError,
  unwrapVariant,
  unwrapDict,
  formatVersion,
  generateMAC,
} from '../../vmManagerShared.js';
import { STATE_NAMES } from './libvirtConstants.js';

export const IS_DARWIN = false;

export const connectionState = {
  bus: null,
  connectIface: null,
  connectProps: null,
  vmStartTimes: new Map(),
  prevVMStats: new Map(),
  /** Set by vmManagerList.js — called on any DomainEvent and after (re)connect. */
  onDomainChange: null,
  /** Set by vmManagerList.js — called on disconnect or bus error. */
  onDisconnect: null,
};

export { vmError, unwrapVariant, unwrapDict, formatVersion, generateMAC };

export async function connect() {
  connectionState.bus = dbus.systemBus();
  const obj = await connectionState.bus.getProxyObject('org.libvirt', '/org/libvirt/QEMU');
  connectionState.connectIface = obj.getInterface('org.libvirt.Connect');
  connectionState.connectProps = obj.getInterface('org.freedesktop.DBus.Properties');

  await connectionState.connectProps.Get('org.libvirt.Connect', 'LibVersion');

  connectionState.connectIface.on('DomainEvent', (_domainPath, event, _detail) => {
    if (event === 5 || event === 1) {
      connectionState.prevVMStats.delete(_domainPath);
    }
    if (connectionState.onDomainChange) connectionState.onDomainChange();
  });

  if (connectionState.onDomainChange) connectionState.onDomainChange();

  connectionState.bus.on('error', (err) => {
    console.error('[vmManager] DBus connection error, reconnecting:', err.message);
    connectionState.connectIface = null;
    connectionState.connectProps = null;
    if (connectionState.onDisconnect) connectionState.onDisconnect();
    setTimeout(connect, 2000);
  });
}

/**
 * Close the system DBus connection (e.g. on process shutdown). Does not reconnect.
 */
export function disconnect() {
  if (!connectionState.bus) return;
  connectionState.bus.removeAllListeners('error');
  try {
    connectionState.bus.disconnect();
  } catch {
    // Bus may already be closed
  }
  connectionState.bus = null;
  connectionState.connectIface = null;
  connectionState.connectProps = null;
  if (connectionState.onDisconnect) connectionState.onDisconnect();
}

export async function getDomainObjAndIface(path) {
  const obj = await connectionState.bus.getProxyObject('org.libvirt', path);
  return {
    iface: obj.getInterface('org.libvirt.Domain'),
    props: obj.getInterface('org.freedesktop.DBus.Properties'),
  };
}

export async function resolveDomain(name) {
  if (!connectionState.connectIface) throw vmError('NO_CONNECTION', 'Not connected to libvirt');
  try {
    const path = await connectionState.connectIface.DomainLookupByName(name);
    return unwrapVariant(path);
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('Domain not found') || msg.includes('virDomainLookupByName')) {
      throw vmError('VM_NOT_FOUND', `VM "${name}" not found`, msg);
    }
    throw vmError('LIBVIRT_ERROR', `Failed to look up VM "${name}"`, msg);
  }
}

export async function getDomainState(path) {
  const { iface } = await getDomainObjAndIface(path);
  const [code] = await iface.GetState(0);
  return { code, name: STATE_NAMES[code] ?? 'unknown' };
}

export async function getDomainXML(path, { inactive = false } = {}) {
  const { iface } = await getDomainObjAndIface(path);
  return iface.GetXMLDesc(inactive ? 2 : 0);
}
