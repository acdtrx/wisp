/**
 * mDNS module facade — Avahi-backed Linux backend (publish .local hostnames
 * and services, plus an in-process DNS forwarder for container queries) and
 * macOS stubs. Single public surface for VM/container managers and any
 * Wisp app-level glue (vmMdnsReconciler, containerMdnsReconciler).
 */
import { platform } from 'node:os';

const impl = await import(
  platform() === 'linux' ? './linux/avahi.js' : './darwin/avahi.js',
);

export { stripCidr, sanitizeHostname } from './hostname.js';
export { KNOWN_SERVICE_TYPES, isValidServiceType, isValidServicePort } from './serviceTypes.js';

export const connect = impl.connect;
export const disconnect = impl.disconnect;
export const registerAddress = impl.registerAddress;
export const deregisterAddress = impl.deregisterAddress;
export const getRegisteredHostname = impl.getRegisteredHostname;
export const registerService = impl.registerService;
export const deregisterService = impl.deregisterService;
export const deregisterServicesForContainer = impl.deregisterServicesForContainer;
