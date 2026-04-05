/**
 * Bridge name heuristics shared with host VLAN tooling (see hostNetworkBridges.js).
 * Names like `eth0.100` or `br0-vlan10` are treated as VLAN-style and skipped for default parent selection.
 */
export function isVlanLikeBridgeName(name) {
  if (!name || typeof name !== 'string') return false;
  return /\.\d+$/.test(name) || /-vlan\d+$/.test(name);
}
