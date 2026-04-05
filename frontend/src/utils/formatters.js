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
 * Format uptime given in seconds (e.g. host uptime).
 */
export function formatUptimeSeconds(seconds) {
  if (seconds == null || seconds < 0) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (d > 0) parts.push(`${d} day${d !== 1 ? 's' : ''}`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 || parts.length === 0) parts.push(`${m}m`);
  return parts.join(' ');
}

export function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

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
