import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { CONFIG_PATH } from './config.js';
import { getMountStatus } from './smbMount.js';
import { createAppError } from './routeErrors.js';

const DEFAULTS = {
  serverName: null,
  refreshIntervalSeconds: 5,
  vmsPath: '/var/lib/wisp/vms',
  imagePath: '/var/lib/wisp/images',
  backupLocalPath: '/var/lib/wisp/backups',
  containersPath: '/var/lib/wisp/containers',
  networkMounts: [],
  backupNetworkMountId: null,
};

function normalizeNetworkMounts(arr) {
  if (!Array.isArray(arr)) return DEFAULTS.networkMounts;
  return arr
    .filter((d) => d && typeof d.id === 'string' && typeof d.label === 'string')
    .map((d) => {
      const mountPath = typeof d.mountPath === 'string' ? d.mountPath.trim() : '';
      const path = typeof d.path === 'string' ? d.path.trim() : mountPath;
      const effectivePath = (path && path.startsWith('/') ? path : mountPath) || '';
      const entry = { id: d.id.trim(), label: d.label.trim(), path: effectivePath, mountPath: effectivePath };
      if (d.share && typeof d.share === 'string') entry.share = d.share.trim();
      if (d.username !== undefined) entry.username = typeof d.username === 'string' ? d.username.trim() : '';
      if (d.password !== undefined) entry.password = typeof d.password === 'string' ? d.password : '';
      return entry;
    })
    .filter((d) => d.id && d.path?.startsWith('/'));
}

function normalizeBackupNetworkMountId(val, networkMountIds) {
  if (val === null || val === undefined || val === '') return null;
  if (typeof val !== 'string') return null;
  const id = val.trim();
  if (!id) return null;
  return networkMountIds.includes(id) ? id : null;
}

/**
 * Read settings from wisp-config.json. Returns defaults if file is missing or invalid.
 */
async function readSettingsFile() {
  let data;
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    data = JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return { ...DEFAULTS };
    throw err;
  }
  if (!data) return { ...DEFAULTS };

  const networkMounts = normalizeNetworkMounts(data.networkMounts);
  const mountIds = networkMounts.map((m) => m.id);
  let backupNetworkMountId = null;
  if (typeof data.backupNetworkMountId === 'string' && data.backupNetworkMountId.trim()) {
    const cand = data.backupNetworkMountId.trim();
    if (mountIds.includes(cand)) backupNetworkMountId = cand;
  }

  const fromFile = {
    serverName: typeof data.serverName === 'string' ? data.serverName : DEFAULTS.serverName,
    refreshIntervalSeconds:
      typeof data.refreshIntervalSeconds === 'number' &&
      data.refreshIntervalSeconds >= 1 &&
      data.refreshIntervalSeconds <= 60
        ? data.refreshIntervalSeconds
        : DEFAULTS.refreshIntervalSeconds,
    vmsPath:
      typeof data.vmsPath === 'string' && data.vmsPath.trim().startsWith('/')
        ? data.vmsPath.trim()
        : DEFAULTS.vmsPath,
    imagePath:
      typeof data.imagePath === 'string' && data.imagePath.trim().startsWith('/')
        ? data.imagePath.trim()
        : DEFAULTS.imagePath,
    backupLocalPath:
      typeof data.backupLocalPath === 'string' && data.backupLocalPath.trim().startsWith('/')
        ? data.backupLocalPath.trim()
        : DEFAULTS.backupLocalPath,
    containersPath:
      typeof data.containersPath === 'string' && data.containersPath.trim().startsWith('/')
        ? data.containersPath.trim()
        : DEFAULTS.containersPath,
    networkMounts,
    backupNetworkMountId,
  };
  return fromFile;
}

/**
 * Return merged settings from `wisp-config.json` with defaults for missing/invalid fields.
 */
export async function getSettings() {
  const fromFile = await readSettingsFile();
  const serverName =
    fromFile.serverName != null && fromFile.serverName !== ''
      ? fromFile.serverName
      : 'My Server';
  const vmsPath = fromFile.vmsPath ?? DEFAULTS.vmsPath;
  const imagePath = fromFile.imagePath ?? DEFAULTS.imagePath;
  const refreshIntervalSeconds = fromFile.refreshIntervalSeconds ?? DEFAULTS.refreshIntervalSeconds;
  const backupLocalPath =
    fromFile.backupLocalPath != null && fromFile.backupLocalPath !== ''
      ? fromFile.backupLocalPath
      : DEFAULTS.backupLocalPath;
  const containersPath = fromFile.containersPath ?? DEFAULTS.containersPath;
  const networkMountsStored = fromFile.networkMounts?.length ? fromFile.networkMounts : DEFAULTS.networkMounts;
  let backupNetworkMountId = fromFile.backupNetworkMountId ?? null;
  const mountIds = networkMountsStored.map((m) => m.id);
  if (backupNetworkMountId && !mountIds.includes(backupNetworkMountId)) {
    backupNetworkMountId = null;
  }

  const networkMountsForApi = networkMountsStored.map((d) => ({
    id: d.id,
    label: d.label,
    path: d.path || d.mountPath,
    mountPath: d.mountPath || d.path,
    share: d.share,
    username: d.username != null ? d.username : undefined,
    password: d.password ? '***' : undefined,
  }));

  return {
    serverName,
    vmsPath,
    imagePath,
    refreshIntervalSeconds,
    backupLocalPath,
    containersPath,
    networkMounts: networkMountsForApi,
    backupNetworkMountId,
  };
}

let writeLock = Promise.resolve();

/**
 * Update only the allowed keys in the settings file. Validates refreshIntervalSeconds 1-60.
 * Returns the full merged settings after write. Serialised with a mutex to avoid concurrent write races.
 */
export async function updateSettings(updates) {
  writeLock = writeLock.then(() => _updateSettings(updates));
  return writeLock;
}

async function _updateSettings(updates) {
  const fromFile = await readSettingsFile();
  const next = { ...fromFile };

  if (updates.serverName !== undefined) {
    next.serverName =
      typeof updates.serverName === 'string' && updates.serverName.trim() !== ''
        ? updates.serverName.trim()
        : null;
  }
  if (updates.refreshIntervalSeconds !== undefined) {
    const n = Number(updates.refreshIntervalSeconds);
    next.refreshIntervalSeconds =
      Number.isInteger(n) && n >= 1 && n <= 60 ? n : DEFAULTS.refreshIntervalSeconds;
  }
  if (updates.backupLocalPath !== undefined) {
    next.backupLocalPath =
      typeof updates.backupLocalPath === 'string' && updates.backupLocalPath.trim().startsWith('/')
        ? updates.backupLocalPath.trim()
        : DEFAULTS.backupLocalPath;
  }
  if (updates.networkMounts !== undefined) {
    const normalized = normalizeNetworkMounts(updates.networkMounts);
    const existing = fromFile.networkMounts || [];
    next.networkMounts = normalized.map((d) => {
      const prev = existing.find((e) => e.id === d.id);
      if (prev && (d.password === '***' || d.password === '' || d.password == null)) {
        d.password = prev.password || '';
      }
      return d;
    });
    const ids = new Set(next.networkMounts.map((m) => m.id));
    if (next.backupNetworkMountId && !ids.has(next.backupNetworkMountId)) {
      next.backupNetworkMountId = null;
    }
  }
  if (updates.backupNetworkMountId !== undefined) {
    const ids = (next.networkMounts || []).map((m) => m.id);
    if (updates.backupNetworkMountId === null || updates.backupNetworkMountId === '') {
      next.backupNetworkMountId = null;
    } else if (typeof updates.backupNetworkMountId === 'string') {
      next.backupNetworkMountId = normalizeBackupNetworkMountId(updates.backupNetworkMountId, ids);
    }
  }
  if (updates.vmsPath !== undefined) {
    next.vmsPath =
      typeof updates.vmsPath === 'string' && updates.vmsPath.trim().startsWith('/')
        ? updates.vmsPath.trim()
        : DEFAULTS.vmsPath;
  }
  if (updates.imagePath !== undefined) {
    next.imagePath =
      typeof updates.imagePath === 'string' && updates.imagePath.trim().startsWith('/')
        ? updates.imagePath.trim()
        : DEFAULTS.imagePath;
  }
  if (updates.containersPath !== undefined) {
    next.containersPath =
      typeof updates.containersPath === 'string' && updates.containersPath.trim().startsWith('/')
        ? updates.containersPath.trim()
        : DEFAULTS.containersPath;
  }

  const toWrite = {
    serverName: next.serverName,
    refreshIntervalSeconds: next.refreshIntervalSeconds,
    vmsPath: next.vmsPath,
    imagePath: next.imagePath,
    backupLocalPath: next.backupLocalPath,
    containersPath: next.containersPath,
    networkMounts: (next.networkMounts || []).map((d) => {
      const out = { id: d.id, label: d.label, path: d.path || d.mountPath, mountPath: d.mountPath || d.path };
      if (d.share) out.share = d.share;
      if (d.username !== undefined) out.username = d.username;
      if (d.password !== undefined && d.password !== '' && d.password !== '***') out.password = d.password;
      return out;
    }),
    backupNetworkMountId: next.backupNetworkMountId,
  };

  await writeFile(CONFIG_PATH, JSON.stringify(toWrite, null, 2), 'utf8');
  return getSettings();
}

/**
 * Return network mounts as stored (including passwords). For server-side use only (e.g. mount).
 */
export async function getRawNetworkMounts() {
  const fromFile = await readSettingsFile();
  return fromFile.networkMounts || [];
}

function mountPathFromBody(body) {
  const mountPath =
    typeof body.mountPath === 'string'
      ? body.mountPath.trim()
      : typeof body.path === 'string'
        ? body.path.trim()
        : '';
  return mountPath;
}

/**
 * Build one stored network mount from API input (add or replace).
 * @param {object} body
 * @param {string} id
 */
function networkMountEntryFromBody(body, id) {
  const mountPath = mountPathFromBody(body);
  if (!mountPath.startsWith('/')) {
    throw createAppError('NETWORK_MOUNT_INVALID', 'mountPath must be an absolute path (start with /)');
  }
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  const entry = {
    id,
    label: label || id.slice(0, 8),
    path: mountPath,
    mountPath,
  };
  const share = typeof body.share === 'string' ? body.share.trim() : '';
  if (share) {
    entry.share = share;
    entry.username = typeof body.username === 'string' ? body.username.trim() : '';
    entry.password = typeof body.password === 'string' ? body.password : '';
  }
  return entry;
}

function networkMountsToPatchPayload(list) {
  return list.map((d) => {
    const out = {
      id: d.id,
      label: d.label,
      path: d.path || d.mountPath,
      mountPath: d.mountPath || d.path,
    };
    if (d.share) {
      out.share = d.share;
      if (d.username !== undefined) out.username = d.username;
      if (d.password !== undefined) out.password = d.password;
    }
    return out;
  });
}

/**
 * Append one network mount (row-scoped). Returns merged settings like getSettings().
 */
export async function addNetworkMount(body) {
  if (!body || typeof body !== 'object') {
    throw createAppError('NETWORK_MOUNT_INVALID', 'Body must be a JSON object');
  }
  const fromFile = await readSettingsFile();
  const id =
    typeof body.id === 'string' && body.id.trim() ? body.id.trim() : randomUUID();
  const existing = fromFile.networkMounts || [];
  if (existing.some((m) => m.id === id)) {
    throw createAppError('NETWORK_MOUNT_DUPLICATE', `Network mount "${id}" already exists`);
  }
  const entry = networkMountEntryFromBody(body, id);
  const combined = [...existing, entry];
  return updateSettings({ networkMounts: networkMountsToPatchPayload(combined) });
}

/**
 * Update one network mount by id. Returns merged settings.
 */
export async function updateNetworkMount(mountId, body) {
  if (!body || typeof body !== 'object') {
    throw createAppError('NETWORK_MOUNT_INVALID', 'Body must be a JSON object');
  }
  const fromFile = await readSettingsFile();
  const list = [...(fromFile.networkMounts || [])];
  const idx = list.findIndex((m) => m.id === mountId);
  if (idx < 0) {
    throw createAppError('NETWORK_MOUNT_NOT_FOUND', `No network mount with id "${mountId}"`);
  }
  const cur = { ...list[idx] };
  if (body.label !== undefined) {
    cur.label = typeof body.label === 'string' ? body.label.trim() : '';
  }
  if (body.share !== undefined) {
    const s = typeof body.share === 'string' ? body.share.trim() : '';
    if (s) {
      cur.share = s;
    } else {
      delete cur.share;
      delete cur.username;
      delete cur.password;
    }
  }
  if (body.mountPath !== undefined || body.path !== undefined) {
    const p = mountPathFromBody(body);
    if (!p.startsWith('/')) {
      throw createAppError('NETWORK_MOUNT_INVALID', 'mountPath must be an absolute path (start with /)');
    }
    cur.path = p;
    cur.mountPath = p;
  }
  if (body.username !== undefined && cur.share) {
    cur.username = typeof body.username === 'string' ? body.username.trim() : '';
  }
  if (body.password !== undefined && cur.share) {
    const pw = body.password;
    if (pw !== '***' && pw !== '' && pw != null) {
      cur.password = typeof pw === 'string' ? pw : '';
    }
  }
  list[idx] = cur;
  return updateSettings({ networkMounts: networkMountsToPatchPayload(list) });
}

/**
 * Remove one network mount. Clears backupNetworkMountId when it pointed at this id.
 */
export async function removeNetworkMount(mountId) {
  const fromFile = await readSettingsFile();
  const existing = fromFile.networkMounts || [];
  const list = existing.filter((m) => m.id !== mountId);
  if (list.length === existing.length) {
    throw createAppError('NETWORK_MOUNT_NOT_FOUND', `No network mount with id "${mountId}"`);
  }
  const updates = { networkMounts: networkMountsToPatchPayload(list) };
  if (fromFile.backupNetworkMountId === mountId) {
    updates.backupNetworkMountId = null;
  }
  return updateSettings(updates);
}

/**
 * Configured backup roots for path validation (restore/delete). Includes local and optional network mount path.
 * @param {Awaited<ReturnType<typeof getSettings>>} settings
 */
export function listConfiguredBackupRoots(settings) {
  const roots = [];
  if (settings.backupLocalPath) roots.push(settings.backupLocalPath);
  const id = settings.backupNetworkMountId;
  if (!id) return roots;
  const d = (settings.networkMounts || []).find((m) => m.id === id);
  const path = d && (d.mountPath || d.path);
  if (path && !roots.includes(path)) roots.push(path);
  return roots;
}

/**
 * Backup destinations for labels/paths (no mount check).
 * @param {Awaited<ReturnType<typeof getSettings>>} settings
 */
export function buildBackupDestinationsFromSettings(settings) {
  const destinations = [];
  const seen = new Set();
  if (settings.backupLocalPath) {
    destinations.push({ path: settings.backupLocalPath, label: 'Local' });
    seen.add(settings.backupLocalPath);
  }
  const id = settings.backupNetworkMountId;
  if (!id) return destinations;
  const d = (settings.networkMounts || []).find((m) => m.id === id);
  const path = d && (d.mountPath || d.path);
  if (!path || seen.has(path)) return destinations;
  seen.add(path);
  destinations.push({ path, label: (d.label && d.label.trim()) || 'Network' });
  return destinations;
}

/**
 * Destinations to scan for backup listings; SMB paths only if currently mounted.
 * @param {Awaited<ReturnType<typeof getSettings>>} settings
 */
export async function listBackupDestinationsWithMountCheck(settings) {
  const destinations = [];
  if (settings.backupLocalPath) {
    destinations.push({ path: settings.backupLocalPath, label: 'Local' });
  }
  const id = settings.backupNetworkMountId;
  if (!id) return destinations;
  const d = (settings.networkMounts || []).find((m) => m.id === id);
  const path = d && (d.mountPath || d.path);
  if (!path) return destinations;
  if (d.share) {
    const { mounted } = await getMountStatus(path);
    if (!mounted) return destinations;
  }
  if (!destinations.some((x) => x.path === path)) {
    destinations.push({ path, label: (d.label && d.label.trim()) || 'Network' });
  }
  return destinations;
}
