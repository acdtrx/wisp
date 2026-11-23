/**
 * Shared formatting helpers for display.
 */

/** A memory size given in MiB: MB below 1 GB, then GB to one decimal, a whole number
 *  without ".0" (`512 MB`, `1.5 GB`, `8 GB`); `—` for a missing size. */
export function formatMemory(mib) {
  if (!Number.isFinite(mib) || mib < 0) return '—';
  if (mib < 1024) return `${Math.round(mib)} MB`;
  const gb = Math.round((mib / 1024) * 10) / 10;
  return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
}

/**
 * A memory amount out of a limit, both in MiB, as formatMemory writes each: the unit
 * once when both are in it ("12 / 256 MB", "1.5 / 2 GB"), else both ("512 MB / 2 GB").
 */
export function formatMemoryOf(usedMib, limitMib) {
  const used = formatMemory(usedMib);
  const limit = formatMemory(limitMib);
  const [usedNum, usedUnit] = used.split(' ');
  const [limitNum, limitUnit] = limit.split(' ');
  return usedUnit && usedUnit === limitUnit ? `${usedNum} / ${limitNum} ${limitUnit}` : `${used} / ${limit}`;
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

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** A value in a unit as shown: whole bytes; otherwise one decimal under 100, none from 100 up. */
function shownIn(value, unit) {
  if (unit === 0) return String(Math.round(value));
  const tenths = Math.round(value * 10) / 10;
  return tenths < 100 ? tenths.toFixed(1) : String(Math.round(value));
}

/**
 * A byte count for display, in powers of 1024: whole bytes, then one decimal under 100
 * and none from 100 up (`512 B`, `1.5 KB`, `14.9 GB`, `937 GB`). The decimals are chosen
 * after rounding, and a value that rounds to 1024 is shown in the next unit, so there is
 * never `100.0 MB` nor `1024 MB`. A missing or invalid count is `—`.
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  let unit = 0;
  let value = bytes;
  while (unit < BYTE_UNITS.length - 1 && Number(shownIn(value, unit)) >= 1024) {
    value /= 1024;
    unit += 1;
  }
  return `${shownIn(value, unit)} ${BYTE_UNITS[unit]}`;
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
