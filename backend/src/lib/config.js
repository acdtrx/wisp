/**
 * Sync read of wisp-config.json for paths and other app config.
 * Settings (getSettings/updateSettings) is the single writer; this module is for sync consumers (e.g. paths.js).
 */
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CONFIG_PATH = process.env.WISP_CONFIG_PATH || resolve(__dirname, '../../../config/wisp-config.json');

const DEFAULTS = {
  serverName: null,
  vmsPath: '/var/lib/wisp/vms',
  imagePath: '/var/lib/wisp/images',
  backupLocalPath: '/var/lib/wisp/backups',
  containersPath: '/var/lib/wisp/containers',
  mounts: [],
  backupMountId: null,
  trustedProxies: [],
};

function validatePath(val, defaultVal) {
  return typeof val === 'string' && val.trim().startsWith('/') ? val.trim() : defaultVal;
}

// proxy-addr (Fastify's trustProxy backend) accepts these named ranges.
const NAMED_PROXY_RANGES = new Set(['loopback', 'linklocal', 'uniquelocal']);

function isValidProxyEntry(entry) {
  if (typeof entry !== 'string') return false;
  const s = entry.trim();
  if (!s) return false;
  if (NAMED_PROXY_RANGES.has(s)) return true;
  const slash = s.indexOf('/');
  if (slash === -1) return isIP(s) !== 0; // bare IPv4/IPv6
  const fam = isIP(s.slice(0, slash)); // CIDR: <ip>/<prefix>
  if (fam === 0) return false;
  const prefix = s.slice(slash + 1);
  if (!/^\d+$/.test(prefix)) return false;
  return Number(prefix) >= 0 && Number(prefix) <= (fam === 4 ? 32 : 128);
}

/**
 * Sanitize the `trustedProxies` config value into a list Fastify's trustProxy
 * accepts (IPv4/IPv6 addresses, CIDR subnets, or the named ranges loopback /
 * linklocal / uniquelocal). Invalid entries are skipped with a warning rather
 * than thrown — a typo must not crash-loop the systemd service at boot.
 */
export function parseTrustedProxies(val) {
  if (!Array.isArray(val)) return [];
  const out = [];
  for (const e of val) {
    if (isValidProxyEntry(e)) out.push(String(e).trim());
    else if (e != null && e !== '') {
      console.warn(`wisp-config.json: ignoring invalid trustedProxies entry: ${JSON.stringify(e)}`);
    }
  }
  return out;
}

/**
 * Read config synchronously. Returns defaults if file missing or invalid.
 * Used by paths.js and any sync caller. For full settings with env overrides use getSettings().
 */
export function getConfigSync() {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8');
    const data = JSON.parse(raw);
    return {
      serverName: typeof data.serverName === 'string' ? data.serverName : DEFAULTS.serverName,
      vmsPath: validatePath(data.vmsPath, DEFAULTS.vmsPath),
      imagePath: validatePath(data.imagePath, DEFAULTS.imagePath),
      backupLocalPath: validatePath(data.backupLocalPath, DEFAULTS.backupLocalPath),
      containersPath: validatePath(data.containersPath, DEFAULTS.containersPath),
      mounts: Array.isArray(data.mounts) ? data.mounts : DEFAULTS.mounts,
      backupMountId:
        typeof data.backupMountId === 'string' && data.backupMountId.trim()
          ? data.backupMountId.trim()
          : null,
      trustedProxies: parseTrustedProxies(data.trustedProxies),
    };
  } catch (err) {
    if (err.code === 'ENOENT') return { ...DEFAULTS };
    /* parse/read error — fall back to defaults rather than crash sync callers.
       getConfigSync runs synchronously from module top-level (paths.js etc.)
       before any Pino logger exists, so console here is the fallback. */
    console.warn('wisp-config.json parse error, using defaults:', err.message);
    return { ...DEFAULTS };
  }
}

export { CONFIG_PATH };
