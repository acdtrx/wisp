/**
 * Host bridge enumeration stubs (macOS dev — no /sys/class/net or /proc).
 */

export async function listHostBridges() {
  return [];
}

export async function getDefaultContainerParentBridge() {
  return undefined;
}

export async function getDefaultBridge() {
  const envBridge = process.env.WISP_DEFAULT_BRIDGE?.trim();
  if (envBridge) return envBridge;
  return 'virbr0';
}

export async function ipv4CidrFromProcFibTrie() {
  return null;
}
