/**
 * Host USB enumeration facade: Linux sysfs + hotplug vs macOS no-op.
 */
import { platform } from 'node:os';

const impl = await import(
  platform() === 'linux' ? './linux/host/usbMonitor.js' : './darwin/host/usbMonitor.js',
);

export const start = impl.start;
export const stop = impl.stop;
export const getDevices = impl.getDevices;
export const onChange = impl.onChange;
