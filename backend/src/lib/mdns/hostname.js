/**
 * Hostname/CIDR helpers for mDNS registration. No DBus — safe on all platforms.
 */

export function stripCidr(ipOrCidr) {
  if (ipOrCidr == null || ipOrCidr === '') return '';
  const s = String(ipOrCidr).trim();
  const slash = s.indexOf('/');
  return slash >= 0 ? s.slice(0, slash) : s;
}

export function sanitizeHostname(input) {
  if (input == null) return null;
  let out = String(input).toLowerCase().trim();
  if (!out) return null;
  out = out.replace(/[._\s]+/g, '-');
  out = out.replace(/[^a-z0-9-]/g, '-');
  out = out.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  if (!out) return null;
  if (out.length > 63) out = out.slice(0, 63).replace(/-+$/g, '');
  return out || null;
}
