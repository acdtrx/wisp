/**
 * Netplan/VLAN bridge stub (macOS dev).
 */
import { networkingError } from '../networkingError.js';

const UNAVAILABLE = 'NETWORK_BRIDGE_UNAVAILABLE';

export async function listManagedNetworkBridges() {
  return [];
}

export async function listEligibleParentBridges() {
  return [];
}

export async function createManagedNetworkBridge() {
  throw networkingError(UNAVAILABLE, 'Managed network bridges are only supported on Linux', 'Unsupported platform');
}

export async function deleteManagedNetworkBridge() {
  throw networkingError(UNAVAILABLE, 'Managed network bridges are only supported on Linux', 'Unsupported platform');
}
