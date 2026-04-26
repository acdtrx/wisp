/**
 * mDNS (Avahi on Linux) facade: platform-specific implementation.
 */
import { platform } from 'node:os';

export { stripCidr, sanitizeHostname } from './mdnsHostname.js';

const impl = await import(
  platform() === 'linux' ? './linux/mdnsManager.js' : './darwin/mdnsManager.js',
);

export const connect = impl.connect;
export const disconnect = impl.disconnect;
export const registerAddress = impl.registerAddress;
export const deregisterAddress = impl.deregisterAddress;
export const getRegisteredHostname = impl.getRegisteredHostname;
export const registerService = impl.registerService;
export const deregisterService = impl.deregisterService;
export const deregisterServicesForContainer = impl.deregisterServicesForContainer;
