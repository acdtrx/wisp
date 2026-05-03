/**
 * Bridge name heuristic shared by host bridge enumeration (hostBridges) and the
 * netplan-managed VLAN bridge tooling (managedBridges). Names like `eth0.100` or
 * `br0-vlan10` are treated as VLAN-style and excluded from default-parent selection.
 */
export function isVlanLikeBridgeName(name) {
  if (!name || typeof name !== 'string') return false;
  return /\.\d+$/.test(name) || /-vlan\d+$/.test(name);
}
