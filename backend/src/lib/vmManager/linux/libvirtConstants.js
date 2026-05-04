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
export const VIR_DOMAIN_SNAPSHOT_CREATE_REDEFINE = 0x1;

export const VIR_DOMAIN_INTERFACE_ADDRESSES_SRC_AGENT = 1;

/* virDomainStatsTypes — bitmask passed to org.libvirt.Domain.GetStats. */
export const VIR_DOMAIN_STATS_STATE = 1 << 0;          // 1
export const VIR_DOMAIN_STATS_CPU_TOTAL = 1 << 1;      // 2
export const VIR_DOMAIN_STATS_BALLOON = 1 << 2;        // 4 — queries qemu monitor; slow
export const VIR_DOMAIN_STATS_VCPU = 1 << 3;           // 8
export const VIR_DOMAIN_STATS_INTERFACE = 1 << 4;      // 16
export const VIR_DOMAIN_STATS_BLOCK = 1 << 5;          // 32

/**
 * Stats bitmask used by getVMStats — only the groups whose fields we actually read
 * (cpu.time, vcpu.*.time, block.*.rd/wr.bytes, net.*.rx/tx.bytes). Passing 0 means
 * "default set" which additionally includes BALLOON (qemu monitor round-trip) and
 * STATE (we already trust the cached state); both pure overhead on the SSE hot path.
 */
export const VM_STATS_MASK =
  VIR_DOMAIN_STATS_CPU_TOTAL |
  VIR_DOMAIN_STATS_VCPU |
  VIR_DOMAIN_STATS_INTERFACE |
  VIR_DOMAIN_STATS_BLOCK;
