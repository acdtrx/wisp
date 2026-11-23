/**
 * Networking module facade — host bridge enumeration, default-bridge selection,
 * /proc-based container IPv4/IPv6 readout, and netplan-managed VLAN bridges.
 * Single public surface for VM/container managers and host routes.
 */
import { platform } from 'node:os';

import { createEmitter } from '../base/index.js';

const isLinux = platform() === 'linux';

const hostImpl = await import(
  isLinux ? './linux/hostBridges.js' : './darwin/hostBridges.js',
);
const managedImpl = await import(
  isLinux ? './linux/managedBridges.js' : './darwin/managedBridges.js',
);

/** The start's logger, set by configure(). */
let logger = null;

/** Boot wiring (lib/managerBootstrap.js): the start's logger. */
export function configure(cfg = {}) {
  logger = cfg.logger ?? null;
}

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
const bridgesChange = createEmitter('networking: bridges change', () => logger);

export const subscribeNetworkBridgesChange = bridgesChange.subscribe;

function announceNetworkBridgesChange() {
  bridgesChange.emit();
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
