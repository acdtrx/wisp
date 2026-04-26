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

export async function registerService() {
  return false;
}

export async function deregisterService() {}

export async function deregisterServicesForContainer() {}
