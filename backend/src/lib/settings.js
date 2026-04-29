import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { CONFIG_PATH } from './config.js';
import { getMountStatus } from './smbMount.js';
import { createAppError } from './routeErrors.js';
import { writeJsonAtomic } from './atomicJson.js';

// Storage mounts must live under this prefix. Constraining the mountPath stops
// an authenticated admin from mounting a hostile share over /etc, /usr, /home,
// etc. Setup scripts ensure /mnt/wisp/ exists at install time.
export const MOUNT_ROOT = '/mnt/wisp';

function assertMountPathUnderRoot(mountPath) {
  const resolved = path.resolve(mountPath);
  if (resolved !== MOUNT_ROOT && !resolved.startsWith(`${MOUNT_ROOT}/`)) {
    throw createAppError('MOUNT_INVALID', `mountPath must be under ${MOUNT_ROOT}/`);
  }
  if (resolved === MOUNT_ROOT) {
    throw createAppError('MOUNT_INVALID', `mountPath cannot be ${MOUNT_ROOT} itself; pick a sub-directory`);
  }
}

const DEFAULTS = {
  serverName: null,
  vmsPath: '/var/lib/wisp/vms',
  imagePath: '/var/lib/wisp/images',
  backupLocalPath: '/var/lib/wisp/backups',
  containersPath: '/var/lib/wisp/containers',
  mounts: [],
  backupMountId: null,
};

const VALID_DISK_FSTYPES = new Set(['ext4', 'btrfs', 'vfat', 'exfat', 'ntfs3']);

function normalizeMounts(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const d of arr) {
    if (!d || typeof d.id !== 'string' || !d.id.trim()) continue;
    const type = d.type === 'smb' || d.type === 'disk' ? d.type : null;
    if (!type) continue;
    const mountPath = typeof d.mountPath === 'string' ? d.mountPath.trim() : '';
    if (!mountPath.startsWith('/')) continue;
    const id = d.id.trim();
    const label = typeof d.label === 'string' ? d.label.trim() : '';
    const autoMount = d.autoMount !== false;
    const entry = { id, type, label, mountPath, autoMount };
    if (type === 'smb') {
      const share = typeof d.share === 'string' ? d.share.trim() : '';
      if (!share) continue;
      entry.share = share;
      entry.username = typeof d.username === 'string' ? d.username.trim() : '';
      entry.password = typeof d.password === 'string' ? d.password : '';
    } else {
      const uuid = typeof d.uuid === 'string' ? d.uuid.trim() : '';
      if (!uuid) continue;
      entry.uuid = uuid;
      entry.fsType = VALID_DISK_FSTYPES.has(d.fsType) ? d.fsType : '';
      entry.readOnly = d.readOnly === true;
    }
    out.push(entry);
  }
  return out;
}

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

  const mounts = normalizeMounts(data.mounts);
  const mountIds = mounts.map((m) => m.id);
  let backupMountId = null;
  if (typeof data.backupMountId === 'string' && data.backupMountId.trim()) {
    const cand = data.backupMountId.trim();
    if (mountIds.includes(cand)) backupMountId = cand;
  }

  return {
    serverName: typeof data.serverName === 'string' ? data.serverName : DEFAULTS.serverName,
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
    mounts,
    backupMountId,
  };
}

function mountForApi(d) {
  const base = {
    id: d.id,
    type: d.type,
    label: d.label,
    mountPath: d.mountPath,
    autoMount: d.autoMount !== false,
  };
  if (d.type === 'smb') {
    base.share = d.share;
    base.username = d.username != null ? d.username : undefined;
    /* Never expose the password — even masked. The boolean below tells the UI
     * whether one is on file so it can render an empty input with a "saved"
     * affordance, without giving any secret-shaped string back to the client. */
    base.hasPassword = !!d.password;
  } else if (d.type === 'disk') {
    base.uuid = d.uuid;
    base.fsType = d.fsType || undefined;
    base.readOnly = d.readOnly === true;
  }
  return base;
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
  const mountsStored = fromFile.mounts?.length ? fromFile.mounts : [];
  let backupMountId = fromFile.backupMountId ?? null;
  const mountIds = mountsStored.map((m) => m.id);
  if (backupMountId && !mountIds.includes(backupMountId)) {
    backupMountId = null;
  }

  return {
    serverName,
    vmsPath: fromFile.vmsPath,
    imagePath: fromFile.imagePath,
    backupLocalPath: fromFile.backupLocalPath,
    containersPath: fromFile.containersPath,
    mounts: mountsStored.map(mountForApi),
    backupMountId,
  };
}

let writeLock = Promise.resolve();

/**
 * Update only the allowed top-level keys. Mount CRUD goes via dedicated mounts lib.
 * Returns the full merged settings after write. Serialised via a mutex; reads
 * happen inside the lock to avoid lost-update races.
 */
export async function updateSettings(updates) {
  return withSettingsWriteLock((fromFile) => buildUpdatedSettings(fromFile, updates));
}

function buildUpdatedSettings(fromFile, updates) {
  const next = { ...fromFile };

  if (updates.serverName !== undefined) {
    next.serverName =
      typeof updates.serverName === 'string' && updates.serverName.trim() !== ''
        ? updates.serverName.trim()
        : null;
  }
  if (updates.backupLocalPath !== undefined) {
    next.backupLocalPath =
      typeof updates.backupLocalPath === 'string' && updates.backupLocalPath.trim().startsWith('/')
        ? updates.backupLocalPath.trim()
        : DEFAULTS.backupLocalPath;
  }
  if (updates.backupMountId !== undefined) {
    const ids = (next.mounts || []).map((m) => m.id);
    if (updates.backupMountId === null || updates.backupMountId === '') {
      next.backupMountId = null;
    } else if (typeof updates.backupMountId === 'string') {
      const id = updates.backupMountId.trim();
      next.backupMountId = ids.includes(id) ? id : null;
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

  return next;
}

/**
 * Read-modify-write a single mount entry under the write lock so concurrent
 * callers can't race on `readSettingsFile() → persistSettings()`.
 *
 * `mutate(state)` returns the new state object (or throws to abort the write).
 * Returns the merged settings as `getSettings()` would.
 */
async function withSettingsWriteLock(mutate) {
  writeLock = writeLock.then(async () => {
    const fromFile = await readSettingsFile();
    const next = await mutate(fromFile);
    if (next) await persistSettings(next);
  });
  await writeLock;
  return getSettings();
}

async function persistSettings(state) {
  const toWrite = {
    serverName: state.serverName,
    vmsPath: state.vmsPath,
    imagePath: state.imagePath,
    backupLocalPath: state.backupLocalPath,
    containersPath: state.containersPath,
    mounts: (state.mounts || []).map((d) => {
      const out = {
        id: d.id,
        type: d.type,
        label: d.label,
        mountPath: d.mountPath,
        autoMount: d.autoMount !== false,
      };
      if (d.type === 'smb') {
        out.share = d.share;
        if (d.username !== undefined) out.username = d.username;
        if (d.password !== undefined && d.password !== '') out.password = d.password;
      } else if (d.type === 'disk') {
        out.uuid = d.uuid;
        if (d.fsType) out.fsType = d.fsType;
        out.readOnly = d.readOnly === true;
      }
      return out;
    }),
    backupMountId: state.backupMountId,
  };
  await writeJsonAtomic(CONFIG_PATH, toWrite);
}

/**
 * Return mounts as stored (including SMB passwords). For server-side use only (e.g. mount, auto-mount).
 */
export async function getRawMounts() {
  const fromFile = await readSettingsFile();
  return fromFile.mounts || [];
}

function validateCommonFields(body) {
  const mountPath = typeof body.mountPath === 'string' ? body.mountPath.trim() : '';
  if (!mountPath.startsWith('/')) {
    throw createAppError('MOUNT_INVALID', 'mountPath must be an absolute path (start with /)');
  }
  assertMountPathUnderRoot(mountPath);
  return mountPath;
}

function mountEntryFromBody(body, id) {
  const type = body.type === 'smb' || body.type === 'disk' ? body.type : null;
  if (!type) {
    throw createAppError('MOUNT_INVALID', 'type must be "smb" or "disk"');
  }
  const mountPath = validateCommonFields(body);
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  const autoMount = body.autoMount !== false;
  const entry = { id, type, label: label || id.slice(0, 8), mountPath, autoMount };
  if (type === 'smb') {
    const share = typeof body.share === 'string' ? body.share.trim() : '';
    if (!share) {
      throw createAppError('MOUNT_INVALID', 'share is required for smb mounts');
    }
    entry.share = share;
    entry.username = typeof body.username === 'string' ? body.username.trim() : '';
    entry.password = typeof body.password === 'string' ? body.password : '';
  } else {
    const uuid = typeof body.uuid === 'string' ? body.uuid.trim() : '';
    if (!uuid) {
      throw createAppError('MOUNT_INVALID', 'uuid is required for disk mounts');
    }
    entry.uuid = uuid;
    if (body.fsType !== undefined) {
      if (!VALID_DISK_FSTYPES.has(body.fsType)) {
        throw createAppError('MOUNT_INVALID', `fsType "${body.fsType}" is not supported`);
      }
      entry.fsType = body.fsType;
    } else {
      entry.fsType = '';
    }
    entry.readOnly = body.readOnly === true;
  }
  return entry;
}

/**
 * Append one mount. Returns merged settings like getSettings().
 */
export async function addMount(body) {
  if (!body || typeof body !== 'object') {
    throw createAppError('MOUNT_INVALID', 'Body must be a JSON object');
  }
  return withSettingsWriteLock((fromFile) => {
    const id =
      typeof body.id === 'string' && body.id.trim() ? body.id.trim() : randomUUID();
    const existing = fromFile.mounts || [];
    if (existing.some((m) => m.id === id)) {
      throw createAppError('MOUNT_DUPLICATE', `Mount "${id}" already exists`);
    }
    const entry = mountEntryFromBody(body, id);
    return { ...fromFile, mounts: [...existing, entry] };
  });
}

/**
 * Update one mount by id. Only label, mountPath, autoMount, and type-specific fields can change.
 * Type cannot be changed after creation.
 */
export async function updateMount(mountId, body) {
  if (!body || typeof body !== 'object') {
    throw createAppError('MOUNT_INVALID', 'Body must be a JSON object');
  }
  return withSettingsWriteLock((fromFile) => {
    const list = [...(fromFile.mounts || [])];
    const idx = list.findIndex((m) => m.id === mountId);
    if (idx < 0) {
      throw createAppError('MOUNT_NOT_FOUND', `No mount with id "${mountId}"`);
    }
    const cur = { ...list[idx] };
    if (body.label !== undefined) {
      cur.label = typeof body.label === 'string' ? body.label.trim() : '';
    }
    if (body.mountPath !== undefined) {
      const p = typeof body.mountPath === 'string' ? body.mountPath.trim() : '';
      if (!p.startsWith('/')) {
        throw createAppError('MOUNT_INVALID', 'mountPath must be an absolute path (start with /)');
      }
      assertMountPathUnderRoot(p);
      cur.mountPath = p;
    }
    if (body.autoMount !== undefined) {
      cur.autoMount = body.autoMount !== false;
    }
    if (cur.type === 'smb') {
      if (body.share !== undefined) {
        const s = typeof body.share === 'string' ? body.share.trim() : '';
        if (!s) {
          throw createAppError('MOUNT_INVALID', 'share cannot be empty for smb mounts');
        }
        cur.share = s;
      }
      if (body.username !== undefined) {
        cur.username = typeof body.username === 'string' ? body.username.trim() : '';
      }
      if (body.password !== undefined) {
        const pw = body.password;
        /* Empty / null means "leave current password as-is"; the frontend only
         * sends `password` when the user actually typed a new one (the saved
         * value is never returned, so they can't echo it back). */
        if (typeof pw === 'string' && pw !== '') {
          cur.password = pw;
        }
      }
    } else if (cur.type === 'disk') {
      if (body.fsType !== undefined) {
        if (!VALID_DISK_FSTYPES.has(body.fsType)) {
          throw createAppError('MOUNT_INVALID', `fsType "${body.fsType}" is not supported`);
        }
        cur.fsType = body.fsType;
      }
      if (body.readOnly !== undefined) {
        cur.readOnly = body.readOnly === true;
      }
    }
    list[idx] = cur;
    return { ...fromFile, mounts: list };
  });
}

/**
 * Remove one mount. Clears backupMountId when it pointed at this id.
 */
export async function removeMount(mountId) {
  return withSettingsWriteLock((fromFile) => {
    const existing = fromFile.mounts || [];
    const list = existing.filter((m) => m.id !== mountId);
    if (list.length === existing.length) {
      throw createAppError('MOUNT_NOT_FOUND', `No mount with id "${mountId}"`);
    }
    return {
      ...fromFile,
      mounts: list,
      backupMountId: fromFile.backupMountId === mountId ? null : fromFile.backupMountId,
    };
  });
}

/**
 * Configured backup roots for path validation (restore/delete). Includes local and optional mount path.
 * @param {Awaited<ReturnType<typeof getSettings>>} settings
 */
export function listConfiguredBackupRoots(settings) {
  const roots = [];
  if (settings.backupLocalPath) roots.push(settings.backupLocalPath);
  const id = settings.backupMountId;
  if (!id) return roots;
  const d = (settings.mounts || []).find((m) => m.id === id);
  const path = d && d.mountPath;
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
  const id = settings.backupMountId;
  if (!id) return destinations;
  const d = (settings.mounts || []).find((m) => m.id === id);
  const path = d && d.mountPath;
  if (!path || seen.has(path)) return destinations;
  seen.add(path);
  destinations.push({ path, label: (d.label && d.label.trim()) || (d.type === 'smb' ? 'Network' : 'Disk') });
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
  const id = settings.backupMountId;
  if (!id) return destinations;
  const d = (settings.mounts || []).find((m) => m.id === id);
  const path = d && d.mountPath;
  if (!path) return destinations;
  if (d.type === 'smb' || d.type === 'disk') {
    const { mounted } = await getMountStatus(path);
    if (!mounted) return destinations;
  }
  if (!destinations.some((x) => x.path === path)) {
    destinations.push({ path, label: (d.label && d.label.trim()) || (d.type === 'smb' ? 'Network' : 'Disk') });
  }
  return destinations;
}
