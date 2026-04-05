/**
 * Host shutdown/reboot (Linux wisp-power) vs stub (macOS dev).
 */
import { platform } from 'node:os';

const impl = await import(
  platform() === 'linux' ? './linux/host/hostPower.js' : './darwin/host/hostPower.js',
);

export const hostShutdown = impl.hostShutdown;
export const hostReboot = impl.hostReboot;
