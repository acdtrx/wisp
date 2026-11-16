/**
 * Networking module facade — host bridge enumeration, default-bridge selection,
 * /proc-based container IPv4/IPv6 readout, and netplan-managed VLAN bridges.
 * Single public surface for VM/container managers and host routes.
 */
import { platform } from 'node:os';

const isLinux = platform() === 'linux';

const hostImpl = await import(
  isLinux ? './linux/hostBridges.js' : './darwin/hostBridges.js',
);
const managedImpl = await import(
  isLinux ? './linux/managedBridges.js' : './darwin/managedBridges.js',
);

export { isVlanLikeBridgeName } from './bridgeNaming.js';

export const listHostBridges = hostImpl.listHostBridges;
export const getDefaultBridge = hostImpl.getDefaultBridge;
export const checkDefaultBridgeOverride = hostImpl.checkDefaultBridgeOverride;
export const getDefaultContainerParentBridge = hostImpl.getDefaultContainerParentBridge;
export const ipv4CidrFromProcFibTrie = hostImpl.ipv4CidrFromProcFibTrie;
export const ipv6GlobalCidrFromProcIfInet6 = hostImpl.ipv6GlobalCidrFromProcIfInet6;

export const listManagedNetworkBridges = managedImpl.listManagedNetworkBridges;
export const listEligibleParentBridges = managedImpl.listEligibleParentBridges;
export const planManagedNetworkBridgeCreate = managedImpl.planManagedNetworkBridgeCreate;
export const planManagedNetworkBridgeDelete = managedImpl.planManagedNetworkBridgeDelete;

/** Notified after a managed bridge create or delete settles. A failed one is
 *  announced too: netplan may have written part of it. No replay: a cue to list
 *  the bridges again. */
const bridgesChangeHandlers = new Set();

export function subscribeNetworkBridgesChange(handler) {
  bridgesChangeHandlers.add(handler);
  return () => bridgesChangeHandlers.delete(handler);
}

function announceNetworkBridgesChange() {
  for (const handler of bridgesChangeHandlers) {
    try {
      handler();
    } catch (err) {
      // A broken subscriber must not fail the change or silence the others.
      console.error('networking: bridges change subscriber failed', err);
    }
  }
}

function announcingBridgesChange(mutation) {
  return async (...args) => {
    try {
      return await mutation(...args);
    } finally {
      announceNetworkBridgesChange();
    }
  };
}

export const createManagedNetworkBridge = announcingBridgesChange(managedImpl.createManagedNetworkBridge);
export const deleteManagedNetworkBridge = announcingBridgesChange(managedImpl.deleteManagedNetworkBridge);
