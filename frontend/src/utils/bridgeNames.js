/** Matches VLAN-style bridge names (e.g. `eth0.100`, `br0-vlan10`); keep in sync with `backend/src/lib/bridgeNaming.js`. */
export function isVlanLikeBridgeName(name) {
  if (!name || typeof name !== 'string') return false;
  return /\.\d+$/.test(name) || /-vlan\d+$/.test(name);
}
