/**
 * Disk monitor stub (macOS dev). Block-device enumeration is Linux-only.
 */

let started = false;

export function start() {
  started = true;
}

export function stop() {
  started = false;
}

export function getDevices() {
  return [];
}

export function refresh() {
  /* no-op */
}

export function onChange() {
  return () => {};
}
