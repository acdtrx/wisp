/**
 * Managed VLAN bridges / netplan (Linux) vs stub (macOS dev).
 */
import { platform } from 'node:os';

const impl = await import(
  platform() === 'linux' ? './linux/host/hostNetworkBridges.js' : './darwin/host/hostNetworkBridges.js',
);

export const listManagedNetworkBridges = impl.listManagedNetworkBridges;
export const listEligibleParentBridges = impl.listEligibleParentBridges;
export const createManagedNetworkBridge = impl.createManagedNetworkBridge;
export const deleteManagedNetworkBridge = impl.deleteManagedNetworkBridge;
