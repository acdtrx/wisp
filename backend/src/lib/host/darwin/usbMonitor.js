/**
 * USB monitor stub (macOS dev): no sysfs hotplug.
 */

export function start() {}

export function stop() {}

export function getDevices() {
  return [];
}

/**
 * @param {() => void} callback
 * @returns {() => void} unsubscribe
 */
export function onChange(callback) {
  return () => {};
}
