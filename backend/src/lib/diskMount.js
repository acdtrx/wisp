/**
 * Disk mount facade: Linux wisp-mount helper vs macOS stub.
 */
import { platform } from 'node:os';

const impl = await import(
  platform() === 'linux' ? './linux/host/diskMount.js' : './darwin/host/diskMount.js',
);

export const mountDisk = impl.mountDisk;
export const unmountDisk = impl.unmountDisk;
