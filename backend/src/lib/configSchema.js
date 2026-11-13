/**
 * The one schema of config/wisp-config.json (CODING-RULES §4): read strictly,
 * so a typo fails instead of silently becoming a default. config.js (the sync
 * readers) and settings.js (the single writer) both parse the file here, and the
 * write paths validate with the same field checks, so a value the UI saved
 * always passes the next read — and the startup read that gates boot.
 *
 * What parse rejects, with CONFIG_INVALID naming the key: an unknown key at any
 * level, a wrong type, an out-of-range value, and a backupMountId or schedule
 * destination naming no mount (settled 2026-11-13, reversing CFG-4: the write
 * paths prune those references in the write that deletes or swaps the mount,
 * and migration 0007 cleans what older releases left).
 * What it fills in: a missing key takes its default. What it still drops: an
 * assignment to a removed section — an assignment names a workload, and a
 * section delete removes its assignments in the same write anyway.
 */
import { isIP } from 'node:net';
import path from 'node:path';
import { createAppError } from './routeErrors.js';

// Storage mounts must live under this prefix. Constraining the mountPath stops
// an authenticated admin from mounting a hostile share over /etc, /usr, /home,
// etc. Setup scripts ensure /mnt/wisp/ exists at install time.
export const MOUNT_ROOT = '/mnt/wisp';

/* "main" is the implicit fallback bucket — never persisted as a section, but
 * the id every workload reports when it has no explicit assignment (or its
 * assignment points at a section that no longer exists). */
export const MAIN_SECTION_ID = 'main';

/* "ungrouped" is the Home page's implicit bucket — never persisted as a group,
 * but the id every tile reports when no group claims it (a freshly derived
 * link, or one whose group was deleted). Mirrors MAIN_SECTION_ID. */
export const UNGROUPED_GROUP_ID = 'ungrouped';

/** Section, home group, tile override and manual tile names. */
export const MAX_NAME = 64;
/** Home tile ids (a derived tile's id is its URL) and manual tile URLs. */
export const MAX_URL = 2048;

export const VALID_DISK_FSTYPES = new Set(['ext4', 'btrfs', 'vfat', 'exfat', 'ntfs3']);
const BACKUP_SCHEDULE_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const API_TOKEN_SCOPES = new Set(['read', 'admin']);
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
// proxy-addr (Fastify's trustProxy backend) accepts these named ranges.
const NAMED_PROXY_RANGES = new Set(['loopback', 'linklocal', 'uniquelocal']);

const PATH_KEYS = ['vmsPath', 'imagePath', 'backupLocalPath', 'containersPath'];
const TOP_KEYS = new Set([
  '_comment', // the shipped example's note; never written back
  'serverName', ...PATH_KEYS, 'mounts', 'backupMountId', 'backupSchedule', 'sections',
  'assignments', 'homepage', 'discoveryEnabled', 'advertisedUrl', 'updateChannel', 'oidc',
  'trustedProxies', 'apiTokens',
]);
const MOUNT_KEYS = {
  smb: new Set(['id', 'type', 'label', 'mountPath', 'autoMount', 'share', 'username', 'password']),
  disk: new Set(['id', 'type', 'label', 'mountPath', 'autoMount', 'uuid', 'fsType', 'readOnly']),
};
const SCHEDULE_KEYS = new Set(['enabled', 'time', 'destinationIds', 'retainDays', 'retainWeeks']);

/** A fresh copy of every key's default — the parse of a missing file. */
export function defaultConfig() {
  return {
    serverName: null,
    vmsPath: '/var/lib/wisp/vms',
    imagePath: '/var/lib/wisp/images',
    backupLocalPath: '/var/lib/wisp/backups',
    containersPath: '/var/lib/wisp/containers',
    mounts: [],
    backupMountId: null,
    backupSchedule: defaultBackupSchedule(),
    sections: [],
    assignments: {},
    homepage: { groups: [], overrides: {}, manualTiles: [] },
    discoveryEnabled: true,
    advertisedUrl: null,
    updateChannel: 'stable',
    oidc: { enabled: false, issuer: '', clientId: '', clientSecret: '' },
    trustedProxies: [],
    apiTokens: [],
  };
}

export function defaultBackupSchedule() {
  return { enabled: false, time: '03:00', destinationIds: ['local'], retainDays: 7, retainWeeks: 4 };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function configInvalid(where, message) {
  return createAppError(
    'CONFIG_INVALID',
    `wisp-config.json${where ? ` → ${where}` : ''}: ${message}`,
  );
}

/** Run a write-side check on a stored value; its error becomes CONFIG_INVALID at `where`. */
function at(where, check) {
  try {
    return check();
  } catch (err) {
    if (err.code === 'CONFIG_INVALID') throw err;
    throw configInvalid(where, err.message);
  }
}

function rejectUnknownKeys(obj, allowed, where) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) throw configInvalid(where ? `${where}.${key}` : key, 'unknown key');
  }
}

function expectObject(v, where) {
  if (!isPlainObject(v)) throw configInvalid(where, 'must be an object');
  return v;
}

function expectArray(v, where) {
  if (!Array.isArray(v)) throw configInvalid(where, 'must be an array');
  return v;
}

function expectBoolean(v, where) {
  if (typeof v !== 'boolean') throw configInvalid(where, 'must be true or false');
  return v;
}

function expectString(v, where) {
  if (typeof v !== 'string') throw configInvalid(where, 'must be a string');
  return v;
}

function expectId(v, where) {
  if (typeof v !== 'string' || !v.trim()) throw configInvalid(where, 'must be a non-empty string');
  return v.trim();
}

// ── Field checks shared with the write paths ────────────────────────────────

/** An absolute path setting (vmsPath, imagePath, backupLocalPath, containersPath). */
export function checkAbsolutePath(value, key) {
  if (typeof value !== 'string' || !value.trim().startsWith('/')) {
    throw createAppError('INVALID_SETTINGS', `${key} must be an absolute path`);
  }
  return value.trim();
}

export function checkUpdateChannel(value) {
  if (value !== 'stable' && value !== 'beta') {
    throw createAppError('INVALID_SETTINGS', 'updateChannel must be "stable" or "beta"');
  }
  return value;
}

/** advertisedUrl: null (or '') clears back to the default announcement. */
export function checkAdvertisedUrl(value) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw createAppError('INVALID_URL', 'advertisedUrl must be a string or null');
  }
  const trimmed = value.trim();
  if (trimmed === '') return null;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw createAppError('INVALID_URL', 'advertisedUrl must be a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw createAppError('INVALID_URL', 'advertisedUrl must use http or https');
  }
  // The URL travels in a single mDNS TXT entry ("url=<value>", 255 bytes max).
  if (Buffer.byteLength(trimmed, 'utf8') > 251) {
    throw createAppError('INVALID_URL', 'advertisedUrl must be at most 251 bytes (mDNS TXT record limit)');
  }
  return trimmed;
}

/** Only fully-configured OIDC may be enabled. A disabled or blank config is fine. */
export function checkOidc(oidc) {
  if (!oidc || oidc.enabled !== true) return;
  let parsed;
  try {
    parsed = new URL(oidc.issuer || '');
  } catch {
    throw createAppError('INVALID_OIDC', 'OIDC issuer must be a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw createAppError('INVALID_OIDC', 'OIDC issuer must use http or https');
  }
  if (!oidc.clientId) throw createAppError('INVALID_OIDC', 'OIDC client ID is required');
  if (!oidc.clientSecret) throw createAppError('INVALID_OIDC', 'OIDC client secret is required');
}

/** One backup-schedule field (`enabled`, `time`, `retainDays`, `retainWeeks`). */
export function checkBackupScheduleField(key, value) {
  switch (key) {
    case 'enabled':
      if (typeof value !== 'boolean') {
        throw createAppError('INVALID_BACKUP_SCHEDULE', 'enabled must be true or false');
      }
      return value;
    case 'time':
      if (typeof value !== 'string' || !BACKUP_SCHEDULE_TIME_RE.test(value.trim())) {
        throw createAppError('INVALID_BACKUP_SCHEDULE', 'Schedule time must be HH:MM (24-hour)');
      }
      return value.trim();
    case 'retainDays':
      if (!Number.isInteger(value) || value < 1 || value > 365) {
        throw createAppError('INVALID_BACKUP_SCHEDULE', 'retainDays must be an integer between 1 and 365');
      }
      return value;
    case 'retainWeeks':
      if (!Number.isInteger(value) || value < 0 || value > 52) {
        throw createAppError('INVALID_BACKUP_SCHEDULE', 'retainWeeks must be an integer between 0 and 52');
      }
      return value;
    default:
      throw createAppError('INVALID_BACKUP_SCHEDULE', `Unknown backup schedule field: ${key}`);
  }
}

/** A non-empty array of destination id strings, deduplicated. Membership is the caller's. */
export function checkDestinationIds(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw createAppError('INVALID_BACKUP_SCHEDULE', 'destinationIds must be a non-empty array');
  }
  for (const id of value) {
    if (typeof id !== 'string' || !id) {
      throw createAppError('INVALID_BACKUP_SCHEDULE', 'destinationIds must hold destination id strings');
    }
  }
  return [...new Set(value)];
}

/** A mount's mountPath: absolute, under MOUNT_ROOT, not MOUNT_ROOT itself. */
export function checkMountPath(value) {
  const mountPath = typeof value === 'string' ? value.trim() : '';
  if (!mountPath.startsWith('/')) {
    throw createAppError('MOUNT_INVALID', 'mountPath must be an absolute path (start with /)');
  }
  const resolved = path.resolve(mountPath);
  if (resolved !== MOUNT_ROOT && !resolved.startsWith(`${MOUNT_ROOT}/`)) {
    throw createAppError('MOUNT_INVALID', `mountPath must be under ${MOUNT_ROOT}/`);
  }
  if (resolved === MOUNT_ROOT) {
    throw createAppError('MOUNT_INVALID', `mountPath cannot be ${MOUNT_ROOT} itself; pick a sub-directory`);
  }
  return mountPath;
}

export function checkFsType(value) {
  if (!VALID_DISK_FSTYPES.has(value)) {
    throw createAppError('MOUNT_INVALID', `fsType "${value}" is not supported`);
  }
  return value;
}

/** A section, group or tile name: trimmed, 1–MAX_NAME characters; null when not. */
export function validName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if (!name || name.length > MAX_NAME) return null;
  return name;
}

/**
 * Accept only absolute http/https URLs. Tiles are rendered as links the user
 * clicks, so anything else (javascript:, data:, a bare hostname) is refused at
 * the API boundary rather than sanitized later (CODING-RULES §9). Null when not.
 */
export function validTileUrl(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_URL) return null;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return trimmed;
}

/** A home tile id: trimmed, 1–MAX_URL characters; null when not. */
export function validTileId(raw) {
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  if (!id || id.length > MAX_URL) return null;
  return id;
}

/** IPv4/IPv6 address, CIDR subnet, or a named range proxy-addr knows. */
export function isValidProxyEntry(entry) {
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

// ── The parse ───────────────────────────────────────────────────────────────

function parseMount(d, where) {
  expectObject(d, where);
  const type = d.type;
  if (type !== 'smb' && type !== 'disk') throw configInvalid(`${where}.type`, 'must be "smb" or "disk"');
  rejectUnknownKeys(d, MOUNT_KEYS[type], where);
  const entry = {
    id: expectId(d.id, `${where}.id`),
    type,
    label: d.label === undefined ? '' : expectString(d.label, `${where}.label`).trim(),
    mountPath: at(`${where}.mountPath`, () => checkMountPath(d.mountPath)),
    autoMount: d.autoMount === undefined ? true : expectBoolean(d.autoMount, `${where}.autoMount`),
  };
  if (type === 'smb') {
    entry.share = expectId(d.share, `${where}.share`);
    entry.username = d.username === undefined ? '' : expectString(d.username, `${where}.username`).trim();
    const password = d.password === undefined ? '' : expectString(d.password, `${where}.password`);
    if (password) entry.password = password;
  } else {
    entry.uuid = expectId(d.uuid, `${where}.uuid`);
    if (d.fsType !== undefined) entry.fsType = at(`${where}.fsType`, () => checkFsType(d.fsType));
    entry.readOnly = d.readOnly === undefined ? false : expectBoolean(d.readOnly, `${where}.readOnly`);
  }
  return entry;
}

function parseBackupSchedule(src, backupMountId) {
  expectObject(src, 'backupSchedule');
  rejectUnknownKeys(src, SCHEDULE_KEYS, 'backupSchedule');
  const out = defaultBackupSchedule();
  for (const key of ['enabled', 'time', 'retainDays', 'retainWeeks']) {
    if (src[key] !== undefined) {
      out[key] = at(`backupSchedule.${key}`, () => checkBackupScheduleField(key, src[key]));
    }
  }
  if (src.destinationIds !== undefined) {
    const ids = at('backupSchedule.destinationIds', () => checkDestinationIds(src.destinationIds));
    const allowed = new Set(['local', ...(backupMountId ? [backupMountId] : [])]);
    for (const id of ids) {
      if (!allowed.has(id)) {
        throw configInvalid('backupSchedule.destinationIds', `"${id}" is neither "local" nor the backupMountId`);
      }
    }
    out.destinationIds = ids;
  }
  return out;
}

function parseSections(arr) {
  expectArray(arr, 'sections');
  const out = [];
  const seen = new Set();
  arr.forEach((s, i) => {
    const where = `sections[${i}]`;
    expectObject(s, where);
    rejectUnknownKeys(s, new Set(['id', 'name', 'order']), where);
    const id = expectId(s.id, `${where}.id`);
    if (id === MAIN_SECTION_ID) throw configInvalid(`${where}.id`, `"${MAIN_SECTION_ID}" is reserved`);
    if (seen.has(id)) throw configInvalid(`${where}.id`, `duplicate id "${id}"`);
    seen.add(id);
    const name = validName(s.name);
    if (!name) throw configInvalid(`${where}.name`, `must be 1–${MAX_NAME} characters`);
    if (!Number.isFinite(s.order)) throw configInvalid(`${where}.order`, 'must be a number');
    out.push({ id, name, order: s.order });
  });
  out.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  return out;
}

function parseAssignments(map, sectionIds) {
  expectObject(map, 'assignments');
  const valid = new Set(sectionIds);
  const out = {};
  for (const [key, value] of Object.entries(map)) {
    if (!/^(vm|container):.+/.test(key)) {
      throw configInvalid(`assignments.${key}`, 'key must be "vm:<name>" or "container:<name>"');
    }
    expectString(value, `assignments.${key}`);
    // An assignment to a removed section falls back to Main.
    if (valid.has(value)) out[key] = value;
  }
  return out;
}

function parseHomepage(src) {
  expectObject(src, 'homepage');
  rejectUnknownKeys(src, new Set(['groups', 'overrides', 'manualTiles']), 'homepage');
  const out = { groups: [], overrides: {}, manualTiles: [] };

  const seenGroups = new Set();
  // A tile belongs to at most one group — the write path moves, never copies.
  const claimed = new Set();
  expectArray(src.groups ?? [], 'homepage.groups').forEach((g, i) => {
    const where = `homepage.groups[${i}]`;
    expectObject(g, where);
    rejectUnknownKeys(g, new Set(['id', 'name', 'tiles']), where);
    const id = expectId(g.id, `${where}.id`);
    if (id === UNGROUPED_GROUP_ID) throw configInvalid(`${where}.id`, `"${UNGROUPED_GROUP_ID}" is reserved`);
    if (seenGroups.has(id)) throw configInvalid(`${where}.id`, `duplicate id "${id}"`);
    seenGroups.add(id);
    const name = validName(g.name);
    if (!name) throw configInvalid(`${where}.name`, `must be 1–${MAX_NAME} characters`);
    const tiles = expectArray(g.tiles ?? [], `${where}.tiles`).map((t, j) => {
      const tile = validTileId(t);
      if (!tile) throw configInvalid(`${where}.tiles[${j}]`, 'must be a tile id');
      if (claimed.has(tile)) throw configInvalid(`${where}.tiles[${j}]`, `tile "${tile}" is already in another group`);
      claimed.add(tile);
      return tile;
    });
    out.groups.push({ id, name, tiles });
  });

  for (const [key, value] of Object.entries(expectObject(src.overrides ?? {}, 'homepage.overrides'))) {
    const where = `homepage.overrides["${key}"]`;
    if (!validTileId(key)) throw configInvalid(where, 'key must be a tile id');
    expectObject(value, where);
    rejectUnknownKeys(value, new Set(['hidden', 'name', 'iconId']), where);
    const entry = {};
    if (value.hidden !== undefined && expectBoolean(value.hidden, `${where}.hidden`)) entry.hidden = true;
    if (value.name !== undefined) {
      const name = validName(value.name);
      if (!name) throw configInvalid(`${where}.name`, `must be 1–${MAX_NAME} characters`);
      entry.name = name;
    }
    if (value.iconId !== undefined) {
      const iconId = expectString(value.iconId, `${where}.iconId`).trim();
      if (iconId) entry.iconId = iconId;
    }
    if (Object.keys(entry).length) out.overrides[key.trim()] = entry;
  }

  const seenTiles = new Set();
  expectArray(src.manualTiles ?? [], 'homepage.manualTiles').forEach((t, i) => {
    const where = `homepage.manualTiles[${i}]`;
    expectObject(t, where);
    rejectUnknownKeys(t, new Set(['id', 'name', 'url', 'iconId']), where);
    const id = expectId(t.id, `${where}.id`);
    if (seenTiles.has(id)) throw configInvalid(`${where}.id`, `duplicate id "${id}"`);
    seenTiles.add(id);
    const name = validName(t.name);
    if (!name) throw configInvalid(`${where}.name`, `must be 1–${MAX_NAME} characters`);
    const url = validTileUrl(t.url);
    if (!url) throw configInvalid(`${where}.url`, 'must be an absolute http or https URL');
    let iconId = null;
    if (t.iconId !== undefined && t.iconId !== null) {
      iconId = expectString(t.iconId, `${where}.iconId`).trim() || null;
    }
    out.manualTiles.push({ id, name, url, iconId });
  });
  return out;
}

function parseOidc(src) {
  expectObject(src, 'oidc');
  rejectUnknownKeys(src, new Set(['enabled', 'issuer', 'clientId', 'clientSecret']), 'oidc');
  const oidc = {
    enabled: src.enabled === undefined ? false : expectBoolean(src.enabled, 'oidc.enabled'),
    issuer: src.issuer === undefined ? '' : expectString(src.issuer, 'oidc.issuer').trim(),
    clientId: src.clientId === undefined ? '' : expectString(src.clientId, 'oidc.clientId').trim(),
    clientSecret: src.clientSecret === undefined ? '' : expectString(src.clientSecret, 'oidc.clientSecret'),
  };
  at('oidc', () => checkOidc(oidc));
  return oidc;
}

function parseTrustedProxyList(arr) {
  return expectArray(arr, 'trustedProxies').map((e, i) => {
    if (!isValidProxyEntry(e)) {
      throw configInvalid(
        `trustedProxies[${i}]`,
        `${JSON.stringify(e)} is not an IP address, a CIDR subnet, or loopback / linklocal / uniquelocal`,
      );
    }
    return e.trim();
  });
}

function parseApiTokens(arr) {
  const seen = new Set();
  return expectArray(arr, 'apiTokens').map((t, i) => {
    const where = `apiTokens[${i}]`;
    expectObject(t, where);
    rejectUnknownKeys(t, new Set(['id', 'label', 'scope', 'tokenHash', 'createdAt']), where);
    const id = expectId(t.id, `${where}.id`);
    if (seen.has(id)) throw configInvalid(`${where}.id`, `duplicate id "${id}"`);
    seen.add(id);
    if (!API_TOKEN_SCOPES.has(t.scope)) throw configInvalid(`${where}.scope`, 'must be "read" or "admin"');
    if (typeof t.tokenHash !== 'string' || !SHA256_HEX_RE.test(t.tokenHash)) {
      throw configInvalid(`${where}.tokenHash`, 'must be a SHA-256 hex digest');
    }
    return {
      id,
      label: t.label === undefined ? '' : expectString(t.label, `${where}.label`).trim(),
      scope: t.scope,
      tokenHash: t.tokenHash,
      createdAt: t.createdAt === undefined ? '' : expectString(t.createdAt, `${where}.createdAt`),
    };
  });
}

/**
 * Parse the decoded wisp-config.json. Returns every key (defaults for the
 * missing ones); throws CONFIG_INVALID naming the first bad key.
 */
export function parseWispConfig(data) {
  if (!isPlainObject(data)) throw configInvalid(null, 'must be a JSON object');
  rejectUnknownKeys(data, TOP_KEYS, null);
  const out = defaultConfig();

  if (data._comment !== undefined) expectString(data._comment, '_comment');
  if (data.serverName !== undefined && data.serverName !== null) {
    out.serverName = expectString(data.serverName, 'serverName');
  }
  for (const key of PATH_KEYS) {
    if (data[key] !== undefined) out[key] = at(key, () => checkAbsolutePath(data[key], key));
  }

  if (data.mounts !== undefined) {
    const seen = new Set();
    out.mounts = expectArray(data.mounts, 'mounts').map((d, i) => {
      const entry = parseMount(d, `mounts[${i}]`);
      if (seen.has(entry.id)) throw configInvalid(`mounts[${i}].id`, `duplicate id "${entry.id}"`);
      seen.add(entry.id);
      return entry;
    });
  }
  if (data.backupMountId !== undefined && data.backupMountId !== null) {
    const id = expectId(data.backupMountId, 'backupMountId');
    if (!out.mounts.some((m) => m.id === id)) throw configInvalid('backupMountId', `no mount with id "${id}"`);
    out.backupMountId = id;
  }
  if (data.backupSchedule !== undefined) {
    out.backupSchedule = parseBackupSchedule(data.backupSchedule, out.backupMountId);
  }

  if (data.sections !== undefined) out.sections = parseSections(data.sections);
  if (data.assignments !== undefined) {
    out.assignments = parseAssignments(data.assignments, out.sections.map((s) => s.id));
  }
  if (data.homepage !== undefined) out.homepage = parseHomepage(data.homepage);

  if (data.discoveryEnabled !== undefined) {
    out.discoveryEnabled = expectBoolean(data.discoveryEnabled, 'discoveryEnabled');
  }
  if (data.advertisedUrl !== undefined) {
    out.advertisedUrl = at('advertisedUrl', () => checkAdvertisedUrl(data.advertisedUrl));
  }
  if (data.updateChannel !== undefined) {
    out.updateChannel = at('updateChannel', () => checkUpdateChannel(data.updateChannel));
  }
  if (data.oidc !== undefined) out.oidc = parseOidc(data.oidc);
  if (data.trustedProxies !== undefined) out.trustedProxies = parseTrustedProxyList(data.trustedProxies);
  if (data.apiTokens !== undefined) out.apiTokens = parseApiTokens(data.apiTokens);
  return out;
}

/** Decode and parse the file's text. Invalid JSON is CONFIG_INVALID too. */
export function parseWispConfigText(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw configInvalid(null, `invalid JSON — ${err.message}`);
  }
  return parseWispConfig(data);
}
