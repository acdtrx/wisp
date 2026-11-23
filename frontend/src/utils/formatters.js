/**
 * Shared formatting helpers for display.
 */

export function formatMemory(mib) {
  if (mib >= 1024) return `${(mib / 1024).toFixed(mib % 1024 === 0 ? 0 : 1)} GB`;
  return `${mib} MB`;
}

/**
 * Format uptime given in milliseconds (e.g. VM stats).
 */
export function formatUptimeMs(ms) {
  if (ms == null || ms < 0) return '—';
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * A byte count for display, in powers of 1024: one decimal under 10, whole above
 * (`512 B`, `1.5 KB`, `20 GB`). Zero is `0 B`; a missing or invalid count is `—`.
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / 1024 ** i;
  if (i === 0) return `${Math.round(val)} B`;
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

/** How long ago an ISO time was (`just now`, `5m ago`, `3h ago`, `2d ago`), its date
 *  after 30 days; `—` for a missing or invalid time. */
export function formatRelativeTime(isoString) {
  if (isoString == null || isoString === '') return '—';
  const parsed = new Date(isoString).getTime();
  if (Number.isNaN(parsed)) return '—';
  const diff = Date.now() - parsed;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(isoString).toLocaleDateString();
}

/** Format a number to one decimal place, or '0.0' if null/undefined. */
export function formatDecimal(n) {
  return n != null ? n.toFixed(1) : '0.0';
}

/**
 * IPv4 for compact display (e.g. status bar). Strips CIDR mask from stored `a.b.c.d/len`.
 */
export function formatLanIpHost(cidrOrIp) {
  if (cidrOrIp == null || cidrOrIp === '') return '';
  const s = String(cidrOrIp);
  return s.includes('/') ? s.replace(/\/\d+$/, '') : s;
}

/** A filesystem UUID's first eight characters, the part a person tells drives apart by. */
export function shortUuid(uuid) {
  return uuid ? uuid.slice(0, 8) : '';
}
