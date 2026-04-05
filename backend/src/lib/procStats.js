/**
 * Host stats from /proc (Linux) vs stub (macOS dev).
 */
import { platform } from 'node:os';

const impl = await import(
  platform() === 'linux' ? './linux/host/procStats.js' : './darwin/host/procStats.js',
);

export const getHostStats = impl.getHostStats;
