/**
 * Host block-device (removable disk) enumeration facade: Linux sysfs+udev vs macOS no-op.
 */
import { platform } from 'node:os';

const impl = await import(
  platform() === 'linux' ? './linux/host/diskMonitor.js' : './darwin/host/diskMonitor.js',
);

export const start = impl.start;
export const stop = impl.stop;
export const getDevices = impl.getDevices;
export const onChange = impl.onChange;
export const refresh = impl.refresh;
