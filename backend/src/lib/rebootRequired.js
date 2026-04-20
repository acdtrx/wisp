/**
 * Host reboot-required signal facade (Linux impl vs macOS stub).
 */
import { platform } from 'node:os';

const impl = await import(
  platform() === 'linux' ? './linux/host/rebootRequired.js' : './darwin/host/rebootRequired.js',
);

export const getRebootSignal = impl.getRebootSignal;
