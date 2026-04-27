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
  /** Subscribers invoked on every libvirt DomainEvent and after (re)connect. */
  domainChangeHandlers: new Set(),
  /** Subscribers invoked on bus disconnect / error. */
  disconnectHandlers: new Set(),
  /** Subscribers invoked on every libvirt AgentEvent (per-domain qemu-ga lifecycle). */
  agentEventHandlers: new Set(),
  /** Per-domain AgentEvent subscriptions: domainPath -> { iface, listener }. */
  agentSubscriptions: new Map(),
};

export { vmError, unwrapVariant, unwrapDict, formatVersion, generateMAC };

/**
 * Subscribe to libvirt domain lifecycle changes. The handler fires on every
 * `DomainEvent` signal from libvirt-dbus and once after each successful
 * (re)connect (so cache rebuilds happen automatically after a bus reset).
 * Subscribers added after `connect()` should run their own initial pass.
 * Returns an unsubscribe function.
 */
export function subscribeDomainChange(handler) {
  connectionState.domainChangeHandlers.add(handler);
  return () => connectionState.domainChangeHandlers.delete(handler);
}

export function subscribeDisconnect(handler) {
  connectionState.disconnectHandlers.add(handler);
  return () => connectionState.disconnectHandlers.delete(handler);
}

/**
 * Subscribe to libvirt per-domain qemu-ga lifecycle (AgentEvent signal).
 * Handler signature: (vmName, { state, reason, domainPath }).
 *   state: 0 = disconnected, 1 = connected (matches VIR_CONNECT_DOMAIN_EVENT_AGENT_LIFECYCLE_STATE_*)
 * Returns an unsubscribe function.
 */
export function subscribeAgentEvent(handler) {
  connectionState.agentEventHandlers.add(handler);
  return () => connectionState.agentEventHandlers.delete(handler);
}

function fireDomainChange() {
  for (const h of connectionState.domainChangeHandlers) {
    try { h(); } catch (err) { console.warn('[vmManager] domain-change handler threw:', err?.message || err); }
  }
}

function fireDisconnect() {
  for (const h of connectionState.disconnectHandlers) {
    try { h(); } catch (err) { console.warn('[vmManager] disconnect handler threw:', err?.message || err); }
  }
}

function fireAgentEvent(vmName, payload) {
  for (const h of connectionState.agentEventHandlers) {
    try { h(vmName, payload); } catch (err) { console.warn('[vmManager] agent-event handler threw:', err?.message || err); }
  }
}

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
    fireDomainChange();
  });

  fireDomainChange();

  connectionState.bus.on('error', (err) => {
    console.error('[vmManager] DBus connection error, reconnecting:', err.message);
    connectionState.connectIface = null;
    connectionState.connectProps = null;
    detachAllAgentSubscriptions();
    fireDisconnect();
    setTimeout(connect, 2000);
  });
}

/**
 * Close the system DBus connection (e.g. on process shutdown). Does not reconnect.
 */
export function disconnect() {
  if (!connectionState.bus) return;
  detachAllAgentSubscriptions();
  connectionState.bus.removeAllListeners('error');
  try {
    connectionState.bus.disconnect();
  } catch {
    // Bus may already be closed
  }
  connectionState.bus = null;
  connectionState.connectIface = null;
  connectionState.connectProps = null;
  fireDisconnect();
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

/**
 * Attach an AgentEvent listener to a per-domain DBus proxy. Idempotent: calling twice
 * for the same path replaces the prior subscription. Used by vmMdnsPublisher to react
 * to qemu-ga connect/disconnect without polling.
 */
export async function attachAgentSubscription(domainPath, vmName) {
  if (!connectionState.bus) return;
  const existing = connectionState.agentSubscriptions.get(domainPath);
  if (existing && existing.vmName === vmName) return;
  if (existing) detachAgentSubscription(domainPath);

  try {
    const { iface } = await getDomainObjAndIface(domainPath);
    const listener = (state, reason) => {
      fireAgentEvent(vmName, { state, reason, domainPath });
    };
    iface.on('AgentEvent', listener);
    connectionState.agentSubscriptions.set(domainPath, { iface, listener, vmName });
  } catch (err) {
    console.warn(`[vmManager] failed to attach AgentEvent for ${vmName}:`, err?.message || err);
  }
}

export function detachAgentSubscription(domainPath) {
  const entry = connectionState.agentSubscriptions.get(domainPath);
  if (!entry) return;
  try { entry.iface.removeListener('AgentEvent', entry.listener); } catch { /* best effort */ }
  connectionState.agentSubscriptions.delete(domainPath);
}

function detachAllAgentSubscriptions() {
  for (const path of [...connectionState.agentSubscriptions.keys()]) {
    detachAgentSubscription(path);
  }
}
