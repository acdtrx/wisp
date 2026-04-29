/**
 * Host GPU enumeration facade — Linux real impl (sysfs / DRM render nodes) vs
 * macOS dev stub (always empty).
 */
import { platform } from 'node:os';

const impl = await import(
  platform() === 'linux' ? './linux/host/hostGpus.js' : './darwin/host/hostGpus.js',
);

export const listHostGpus = impl.listHostGpus;
