import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { CONFIG_PATH, parseTrustedProxies } from './config.js';
import { getMountStatus } from './storage/index.js';
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
  sections: [],
  assignments: {},
  discoveryEnabled: true,
  advertisedUrl: null,
  oidc: { enabled: false, issuer: '', clientId: '', clientSecret: '' },
  trustedProxies: [],
  apiTokens: [],
};

/* "main" is the implicit fallback bucket — never persisted as a section, but
 * the id every workload reports when it has no explicit assignment (or its
 * assignment points at a section that no longer exists). */
export const MAIN_SECTION_ID = 'main';

function normalizeSections(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seenIds = new Set();
  for (const s of arr) {
    if (!s || typeof s.id !== 'string' || !s.id.trim()) continue;
    const id = s.id.trim();
    if (id === MAIN_SECTION_ID || seenIds.has(id)) continue;
    const name = typeof s.name === 'string' ? s.name.trim() : '';
    if (!name) continue;
    const order = Number.isFinite(s.order) ? s.order : out.length;
    seenIds.add(id);
    out.push({ id, name, order });
  }
  out.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  return out;
}

function normalizeAssignments(map, sectionIds) {
  if (!map || typeof map !== 'object') return {};
  const valid = new Set(sectionIds);
  const out = {};
  for (const [key, value] of Object.entries(map)) {
    if (typeof key !== 'string' || !key.includes(':')) continue;
    if (typeof value !== 'string' || !valid.has(value)) continue;
    out[key] = value;
  }
  return out;
}

function normalizeOidc(obj) {
  const src = obj && typeof obj === 'object' ? obj : {};
  const issuer = typeof src.issuer === 'string' ? src.issuer.trim() : '';
  const clientId = typeof src.clientId === 'string' ? src.clientId.trim() : '';
  const clientSecret = typeof src.clientSecret === 'string' ? src.clientSecret : '';
  return {
    // Enabled only ever sticks when the config is actually complete — a
    // half-configured `enabled: true` would auto-redirect logins into a broken
    // provider flow.
    enabled: src.enabled === true && !!issuer && !!clientId && !!clientSecret,
    issuer,
    clientId,
    clientSecret,
  };
}

const API_TOKEN_SCOPES = new Set(['read', 'admin']);
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

function normalizeApiTokens(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seenIds = new Set();
  for (const t of arr) {
    if (!t || typeof t.id !== 'string' || !t.id.trim() || seenIds.has(t.id)) continue;
    if (!API_TOKEN_SCOPES.has(t.scope)) continue;
    if (typeof t.tokenHash !== 'string' || !SHA256_HEX_RE.test(t.tokenHash)) continue;
    seenIds.add(t.id);
    out.push({
      id: t.id,
      label: typeof t.label === 'string' ? t.label.trim() : '',
      scope: t.scope,
      tokenHash: t.tokenHash,
      createdAt: typeof t.createdAt === 'string' ? t.createdAt : '',
    });
  }
  return out;
}

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

  const sections = normalizeSections(data.sections);
  const assignments = normalizeAssignments(
    data.assignments,
    sections.map((s) => s.id),
  );

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
    sections,
    assignments,
    discoveryEnabled:
      typeof data.discoveryEnabled === 'boolean' ? data.discoveryEnabled : DEFAULTS.discoveryEnabled,
    advertisedUrl:
      typeof data.advertisedUrl === 'string' && data.advertisedUrl.trim() !== ''
        ? data.advertisedUrl.trim()
        : DEFAULTS.advertisedUrl,
    oidc: normalizeOidc(data.oidc),
    // Not editable from the UI — an operator sets it directly in wisp-config.json
    // for a non-loopback reverse proxy. Preserved here so a Settings save from the
    // UI (which rewrites the whole file) can't silently drop it.
    trustedProxies: parseTrustedProxies(data.trustedProxies),
    // Managed via /api/auth/tokens, never via PATCH /api/settings — carried
    // through here so any settings save preserves them.
    apiTokens: normalizeApiTokens(data.apiTokens),
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
    sections: fromFile.sections || [],
    assignments: fromFile.assignments || {},
    discoveryEnabled: fromFile.discoveryEnabled,
    advertisedUrl: fromFile.advertisedUrl,
    oidc: oidcForApi(fromFile.oidc),
  };
}

/* Never return the client secret to the client — expose a boolean so the UI can
 * render an empty input with a "saved" affordance, mirroring how SMB mount
 * passwords are masked (`hasPassword`). */
function oidcForApi(oidc) {
  const o = oidc || DEFAULTS.oidc;
  return {
    enabled: o.enabled === true,
    issuer: o.issuer || '',
    clientId: o.clientId || '',
    hasClientSecret: !!o.clientSecret,
  };
}

/**
 * Full OIDC config including the client secret, for server-side use only
 * (the OIDC login/callback routes). Never sent to the client.
 * @returns {Promise<{ enabled: boolean, issuer: string, clientId: string, clientSecret: string }>}
 */
export async function getRawOidcConfig() {
  const fromFile = await readSettingsFile();
  return normalizeOidc(fromFile.oidc);
}

let writeLock = Promise.resolve();

/**
 * Update only the allowed top-level keys. Mount CRUD goes via dedicated mounts lib.
 * Returns the full merged settings after write. Serialised via a mutex; reads
 * happen inside the lock to avoid lost-update races.
 */
export async function updateSettings(updates) {
  if (updates?.advertisedUrl !== undefined) assertValidAdvertisedUrl(updates.advertisedUrl);
  return withSettingsWriteLock((fromFile) => {
    const next = buildUpdatedSettings(fromFile, updates);
    // Validate the *merged* result: the secret may already be on file even when
    // this PATCH doesn't include it, so completeness can only be judged post-merge.
    if (updates.oidc !== undefined) assertValidOidc(next.oidc);
    return next;
  });
}

function assertValidAdvertisedUrl(value) {
  if (value === null || value === '') return; // clears back to the default announcement
  if (typeof value !== 'string') {
    throw createAppError('INVALID_URL', 'advertisedUrl must be a string or null');
  }
  const trimmed = value.trim();
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
}

function assertValidOidc(oidc) {
  // Only fully-configured OIDC may be enabled. A disabled/blank config is fine.
  if (!oidc || oidc.enabled !== true) return;
  const issuer = oidc.issuer || '';
  let parsed;
  try {
    parsed = new URL(issuer);
  } catch {
    throw createAppError('INVALID_OIDC', 'OIDC issuer must be a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw createAppError('INVALID_OIDC', 'OIDC issuer must use http or https');
  }
  if (!oidc.clientId) {
    throw createAppError('INVALID_OIDC', 'OIDC client ID is required');
  }
  if (!oidc.clientSecret) {
    throw createAppError('INVALID_OIDC', 'OIDC client secret is required');
  }
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
  if (updates.discoveryEnabled !== undefined) {
    next.discoveryEnabled = updates.discoveryEnabled === true;
  }
  if (updates.advertisedUrl !== undefined) {
    next.advertisedUrl =
      typeof updates.advertisedUrl === 'string' && updates.advertisedUrl.trim() !== ''
        ? updates.advertisedUrl.trim()
        : null;
  }
  if (updates.oidc !== undefined && updates.oidc && typeof updates.oidc === 'object') {
    const cur = normalizeOidc(next.oidc);
    const u = updates.oidc;
    const merged = { ...cur };
    if (u.issuer !== undefined) merged.issuer = typeof u.issuer === 'string' ? u.issuer.trim() : '';
    if (u.clientId !== undefined) merged.clientId = typeof u.clientId === 'string' ? u.clientId.trim() : '';
    // Empty / omitted secret means "keep the saved one" — the masked GET never
    // returns it, so the client can't echo it back. Same pattern as SMB passwords.
    if (typeof u.clientSecret === 'string' && u.clientSecret !== '') merged.clientSecret = u.clientSecret;
    if (u.enabled !== undefined) merged.enabled = u.enabled === true;
    next.oidc = normalizeOidc(merged);
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
export async function withSettingsWriteLock(mutate) {
  const run = writeLock.then(async () => {
    const fromFile = await readSettingsFile();
    const next = await mutate(fromFile);
    if (next) await persistSettings(next);
  });
  // Keep the chain alive past rejections — a throwing mutate (validation) must
  // fail its own caller only, not poison every subsequent settings write.
  writeLock = run.catch(() => {});
  await run;
  return getSettings();
}

async function persistSettings(state) {
  const sections = normalizeSections(state.sections);
  const assignments = normalizeAssignments(
    state.assignments,
    sections.map((s) => s.id),
  );
  const toWrite = {
    serverName: state.serverName,
    vmsPath: state.vmsPath,
    imagePath: state.imagePath,
    backupLocalPath: state.backupLocalPath,
    containersPath: state.containersPath,
    sections,
    assignments,
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
    discoveryEnabled: state.discoveryEnabled !== false,
    advertisedUrl: state.advertisedUrl ?? null,
    oidc: normalizeOidc(state.oidc),
    trustedProxies: parseTrustedProxies(state.trustedProxies),
    apiTokens: normalizeApiTokens(state.apiTokens),
  };
  // 0600: the file holds secrets (SMB passwords, OIDC client secret). Without an
  // explicit mode the atomic temp file lands at the umask default (usually 0644),
  // silently widening the config back to world-readable on every save.
  await writeJsonAtomic(CONFIG_PATH, toWrite, { mode: 0o600 });
}

/**
 * API tokens as stored (hashes included). Server-side only — the auth hook
 * verifies bearer tokens against these; the UI lists them via lib/apiTokens.js
 * which strips the hashes. Never part of getSettings().
 */
export async function getRawApiTokens() {
  const fromFile = await readSettingsFile();
  return fromFile.apiTokens || [];
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
 * Destinations to scan for backup listings; SMB paths only if currently mounted.
 * The `id` is the same vocabulary the client uses on `POST /api/vms/:name/backup`
 * (`destinationIds`): `'local'` for the configured backupLocalPath, or the
 * mount UUID for the configured backupMountId.
 *
 * @param {Awaited<ReturnType<typeof getSettings>>} settings
 * @returns {Promise<Array<{ id: string, path: string, label: string }>>}
 */
export async function listBackupDestinationsWithMountCheck(settings) {
  const destinations = [];
  if (settings.backupLocalPath) {
    destinations.push({ id: 'local', path: settings.backupLocalPath, label: 'Local' });
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
    destinations.push({ id, path, label: (d.label && d.label.trim()) || (d.type === 'smb' ? 'Network' : 'Disk') });
  }
  return destinations;
}
