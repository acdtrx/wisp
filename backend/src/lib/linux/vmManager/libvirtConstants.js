/**
 * Libvirt constants (state codes, flags) used across vmManager modules.
 * Values match libvirt API; centralised for consistency.
 */

export const STATE_NAMES = {
  0: 'nostate',
  1: 'running',
  2: 'blocked',
  3: 'paused',
  4: 'shutdown',
  5: 'shutoff',
  6: 'crashed',
  7: 'pmsuspended',
};

export const VIR_DOMAIN_STATE_SHUTDOWN = 0;
export const VIR_DOMAIN_STATE_SHUTOFF = 5;
export const VIR_DOMAIN_SNAPSHOT_CREATE_LIVE = 0x100;

export const VIR_DOMAIN_INTERFACE_ADDRESSES_SRC_AGENT = 1;
