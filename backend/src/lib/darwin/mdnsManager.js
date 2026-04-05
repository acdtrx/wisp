/**
 * mDNS stub (macOS dev): no Avahi; registration is a no-op.
 */

export async function connect() {}

export async function disconnect() {}

export async function registerAddress() {
  return null;
}

export async function deregisterAddress() {}

export function getRegisteredHostname() {
  return null;
}
