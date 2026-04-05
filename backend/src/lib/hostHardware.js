/**
 * Host hardware inventory (Linux sysfs/proc) vs stub (macOS dev).
 */
import { platform } from 'node:os';

const impl = await import(
  platform() === 'linux' ? './linux/host/hostHardware.js' : './darwin/host/hostHardware.js',
);

export const getHostHardwareInfo = impl.getHostHardwareInfo;
