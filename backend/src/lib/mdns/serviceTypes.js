/**
 * Built-in mDNS service type catalog used for validation and UI suggestions.
 * Mirrored at frontend/src/lib/mdnsServiceTypes.js — keep both in sync.
 * Platform-agnostic (catalog + regex validators).
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

const SERVICE_TYPE_RE = /^_[a-z0-9-]+\._(tcp|udp)$/;

export function isValidServiceType(type) {
  return typeof type === 'string' && SERVICE_TYPE_RE.test(type);
}

export function isValidServicePort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}
