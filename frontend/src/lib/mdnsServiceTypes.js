/**
 * Built-in mDNS service type catalog used for the per-port service editor.
 * Mirrored at backend/src/lib/linux/mdnsServiceTypes.js — keep both in sync.
 */

export const KNOWN_SERVICE_TYPES = [
  { type: '_smb._tcp', label: 'SMB / CIFS', defaultPort: 445 },
  { type: '_http._tcp', label: 'HTTP', defaultPort: 80 },
  { type: '_https._tcp', label: 'HTTPS', defaultPort: 443 },
  { type: '_ssh._tcp', label: 'SSH', defaultPort: 22 },
  { type: '_sftp-ssh._tcp', label: 'SFTP', defaultPort: 22 },
  { type: '_ftp._tcp', label: 'FTP', defaultPort: 21 },
  { type: '_ipp._tcp', label: 'IPP', defaultPort: 631 },
  { type: '_ipps._tcp', label: 'IPPS', defaultPort: 631 },
  { type: '_webdav._tcp', label: 'WebDAV', defaultPort: 80 },
  { type: '_webdavs._tcp', label: 'WebDAV (TLS)', defaultPort: 443 },
  { type: '_afpovertcp._tcp', label: 'AFP', defaultPort: 548 },
  { type: '_nfs._tcp', label: 'NFS', defaultPort: 2049 },
  { type: '_rdp._tcp', label: 'RDP', defaultPort: 3389 },
  { type: '_vnc._tcp', label: 'VNC', defaultPort: 5900 },
];

/** Default TXT records pre-filled when a known type is selected. */
export const DEFAULT_TXT_FOR_TYPE = {
  '_http._tcp': { path: '/' },
  '_https._tcp': { path: '/' },
  '_webdav._tcp': { path: '/' },
  '_webdavs._tcp': { path: '/' },
  '_ipp._tcp': { rp: 'ipp/print' },
  '_ipps._tcp': { rp: 'ipp/print' },
};

const SERVICE_TYPE_RE = /^_[a-z0-9-]+\._(tcp|udp)$/;

export function isValidServiceType(type) {
  return typeof type === 'string' && SERVICE_TYPE_RE.test(type);
}

/** Parse "80/tcp" or "443" → integer port. */
export function parsePortLabel(label) {
  if (label == null) return null;
  const s = String(label).trim();
  const m = s.match(/^(\d+)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

/** Suggest the most likely service type for a port (first match in catalog), or null. */
export function suggestTypeForPort(port) {
  if (!Number.isInteger(port)) return null;
  const match = KNOWN_SERVICE_TYPES.find((t) => t.defaultPort === port);
  return match ? match.type : null;
}
