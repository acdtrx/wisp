/**
 * Disk monitor stub (macOS dev). Block-device enumeration is Linux-only.
 */

export function start() {}

export function stop() {}

export function getDevices() {
  return [];
}

export function refresh() {
  /* no-op */
}

export function onChange() {
  return () => {};
}
