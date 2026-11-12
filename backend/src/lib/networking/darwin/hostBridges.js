/**
 * Host bridge enumeration stubs (macOS dev — no /sys/class/net or /proc).
 */

export async function listHostBridges() {
  return [];
}

export async function getDefaultContainerParentBridge() {
  return undefined;
}

/** macOS dev has no host bridges to check the override against. */
export async function checkDefaultBridgeOverride() {
  return null;
}

export async function getDefaultBridge() {
  const envBridge = process.env.WISP_DEFAULT_BRIDGE?.trim();
  if (envBridge) return envBridge;
  return 'virbr0';
}

export async function ipv4CidrFromProcFibTrie() {
  return null;
}

export async function ipv6GlobalCidrFromProcIfInet6() {
  return null;
}
