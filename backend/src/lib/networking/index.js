/**
 * Networking module facade — host bridge enumeration, default-bridge selection,
 * /proc-based container IPv4 readout, and netplan-managed VLAN bridges.
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
export const getDefaultContainerParentBridge = hostImpl.getDefaultContainerParentBridge;
export const ipv4CidrFromProcFibTrie = hostImpl.ipv4CidrFromProcFibTrie;

export const listManagedNetworkBridges = managedImpl.listManagedNetworkBridges;
export const listEligibleParentBridges = managedImpl.listEligibleParentBridges;
export const createManagedNetworkBridge = managedImpl.createManagedNetworkBridge;
export const deleteManagedNetworkBridge = managedImpl.deleteManagedNetworkBridge;
