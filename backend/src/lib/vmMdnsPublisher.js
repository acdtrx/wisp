/**
 * VM mDNS publisher facade: platform-specific implementation.
 */
import { platform } from 'node:os';

const impl = await import(
  platform() === 'linux' ? './linux/vmMdnsPublisher.js' : './darwin/vmMdnsPublisher.js',
);

export const startVmMdnsPublisher = impl.startVmMdnsPublisher;
export const stopVmMdnsPublisher = impl.stopVmMdnsPublisher;
export const publishVm = impl.publishVm;
export const unpublishVm = impl.unpublishVm;
