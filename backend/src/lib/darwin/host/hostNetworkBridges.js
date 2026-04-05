/**
 * Netplan/VLAN bridge stub (macOS dev).
 */
import { createAppError } from '../../routeErrors.js';

const UNAVAILABLE = 'NETWORK_BRIDGE_UNAVAILABLE';

export async function listManagedNetworkBridges() {
  return [];
}

export async function listEligibleParentBridges() {
  return [];
}

export async function createManagedNetworkBridge() {
  throw createAppError(UNAVAILABLE, 'Managed network bridges are only supported on Linux', 'Unsupported platform');
}

export async function deleteManagedNetworkBridge() {
  throw createAppError(UNAVAILABLE, 'Managed network bridges are only supported on Linux', 'Unsupported platform');
}
