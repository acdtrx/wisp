import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import { CONFIG_PATH, INSTALL_ROOT } from './config.js';
import {
  checkAbsolutePath,
  checkAdvertisedUrl,
  checkBackupScheduleField,
  checkDestinationIds,
  checkFsType,
  checkMountPath,
  checkOidc,
  checkShare,
  checkUpdateChannel,
  defaultConfig,
  mountOnPath,
  parseWispConfig,
  parseWispConfigText,
} from './configSchema.js';
import { getMountStatus } from './storage/index.js';
import { createAppError } from './appErrors.js';
import { writeJsonAtomic } from './base/index.js';
import {
  MAX_SSH_KEYS, defaultSshKeyName, parseSshKey, readSshKey, sshKeyFingerprint, validSshKeyName,
} from './sshKeys.js';
import { createEmitter } from './base/index.js';
import { log } from './log.js';

export { MOUNT_ROOT, MAIN_SECTION_ID, UNGROUPED_GROUP_ID } from './configSchema.js';

/**
 * Strict PATCH-side merge: any field the client actually sends must be valid,
 * otherwise the whole update is rejected with INVALID_BACKUP_SCHEDULE (422).
 * The field checks are the ones the read applies (configSchema.js).
 */
function mergeBackupSchedule(current, updates, backupMountId) {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    throw createAppError('INVALID_BACKUP_SCHEDULE', 'backupSchedule must be an object');
  }
  const merged = { ...current };
  for (const key of ['enabled', 'time', 'retainDays', 'retainWeeks']) {
    if (updates[key] !== undefined) merged[key] = checkBackupScheduleField(key, updates[key]);
  }
  if (updates.destinationIds !== undefined) {
    const ids = checkDestinationIds(updates.destinationIds);
    const allowed = new Set(['local', ...(backupMountId ? [backupMountId] : [])]);
    for (const id of ids) {
      if (!allowed.has(id)) {
        throw createAppError('INVALID_BACKUP_SCHEDULE', `Unknown backup destination id: ${id}`);
      }
    }
    merged.destinationIds = ids;
  }
  return merged;
}

/**
 * Drop every schedule destination that is no longer `'local'` or the backup
 * mount — after a write that removes or swaps it, so the file never names a
 * mount that isn't there (the read refuses one). An emptied list is `['local']`.
 */
function pruneBackupDestinations(state) {
  const allowed = new Set(['local', ...(state.backupMountId ? [state.backupMountId] : [])]);
  const kept = state.backupSchedule.destinationIds.filter((id) => allowed.has(id));
  return { ...state, backupSchedule: { ...state.backupSchedule, destinationIds: kept.length > 0 ? kept : ['local'] } };
}

/** The parsed file: every key present, defaults for missing ones. Throws CONFIG_INVALID. */
async function readSettingsFile() {
  let raw;
  try {
    raw = await readFile(CONFIG_PATH, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return defaultConfig();
    throw err;
  }
  return parseWispConfigText(raw);
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
 * Return merged settings from `wisp-config.json`, with defaults for missing fields.
 */
export async function getSettings() {
  const fromFile = await readSettingsFile();
  const serverName =
    fromFile.serverName != null && fromFile.serverName !== ''
      ? fromFile.serverName
      : 'My Server';

  return {
    serverName,
    vmsPath: fromFile.vmsPath,
    imagePath: fromFile.imagePath,
    backupLocalPath: fromFile.backupLocalPath,
    containersPath: fromFile.containersPath,
    mounts: fromFile.mounts.map(mountForApi),
    backupMountId: fromFile.backupMountId,
    backupSchedule: fromFile.backupSchedule,
    sections: fromFile.sections,
    assignments: fromFile.assignments,
    discoveryEnabled: fromFile.discoveryEnabled,
    advertisedUrl: fromFile.advertisedUrl,
    updateChannel: fromFile.updateChannel,
    oidc: oidcForApi(fromFile.oidc),
    sshKeys: fromFile.sshKeys.map(sshKeyForApi),
  };
}

/* Never return the client secret to the client — expose a boolean so the UI can
 * render an empty input with a "saved" affordance, mirroring how SMB mount
 * passwords are masked (`hasPassword`). */
function oidcForApi(o) {
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
  return fromFile.oidc;
}

let writeLock = Promise.resolve();

/** Notified after every write that changes what `getSettings()` returns: the
 *  settings fields, OIDC and the mounts. Sections, homepage and token writes share
 *  the write lock but not this signal: they have their own topics. No replay —
 *  it is a cue to read the settings again, not their state. */
const settingsChange = createEmitter('settings: change', log);

export const subscribeSettingsChange = settingsChange.subscribe;

/** Notified after a mount is added, edited or removed (on top of the settings
 *  cue every write gives). No replay: a cue to read the mounts again. */
const mountsChange = createEmitter('settings: mounts change', log);

export const subscribeMountsChange = mountsChange.subscribe;

function announceMountsChange() {
  mountsChange.emit();
}

/** Persist a settings change, then announce it. A mutator that throws rejects
 *  before any handler runs. Returns the state as written, never a read-back, so
 *  a write that landed never fails on reading it back. */
async function commitSettings(mutate) {
  const written = await writeSettingsUnderLock(mutate);
  settingsChange.emit();
  return written;
}

/**
 * Update only the allowed top-level keys. Mount CRUD goes via dedicated mounts lib;
 * OIDC via `updateOidcSettings`.
 * Serialised via a mutex; reads happen inside the lock to avoid lost-update races.
 */
export async function updateSettings(updates) {
  await commitSettings((fromFile) => buildUpdatedSettings(fromFile, updates));
}

/**
 * Update the OIDC block only. Separate from `updateSettings` because its route
 * is session-only (a token that could repoint SSO would mint itself a browser
 * session — docs/specs/AUTH.md § Denied surfaces).
 */
export async function updateOidcSettings(updates) {
  await commitSettings((fromFile) => {
    const next = { ...fromFile, oidc: mergeOidc(fromFile.oidc, updates || {}) };
    // Validate the *merged* result: the secret may already be on file even when
    // this PATCH doesn't include it, so completeness can only be judged post-merge.
    checkOidc(next.oidc);
    return next;
  });
}

function mergeOidc(cur, u) {
  const merged = { ...cur };
  for (const key of ['issuer', 'clientId']) {
    if (u[key] === undefined) continue;
    if (typeof u[key] !== 'string') throw createAppError('INVALID_OIDC', `${key} must be a string`);
    merged[key] = u[key].trim();
  }
  // Empty / omitted secret means "keep the saved one" — the masked GET never
  // returns it, so the client can't echo it back. Same pattern as SMB passwords.
  const newSecret = typeof u.clientSecret === 'string' && u.clientSecret !== '' ? u.clientSecret : null;
  if (newSecret) merged.clientSecret = newSecret;
  // The saved secret belongs to the saved issuer + client: never carry it to
  // another one, where it would be sent to that provider's token endpoint.
  const identityChanged = merged.issuer !== cur.issuer || merged.clientId !== cur.clientId;
  if (identityChanged && !newSecret && cur.clientSecret) {
    if (merged.issuer && merged.clientId) {
      throw createAppError(
        'INVALID_OIDC',
        'Re-enter the client secret when changing the issuer or client ID',
        'The saved client secret is never reused for a different issuer or client',
      );
    }
    // Clearing the provider: drop the secret with it.
    merged.clientSecret = '';
  }
  if (u.enabled !== undefined) {
    if (typeof u.enabled !== 'boolean') throw createAppError('INVALID_OIDC', 'enabled must be true or false');
    merged.enabled = u.enabled;
  }
  return merged;
}

/** Whether `p` is `root` or inside it (both resolved). */
function isWithin(root, p) {
  const rel = relative(resolve(root), resolve(p));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Apply a PATCH /api/settings body. Every sent field must be valid — the same
 * checks the read applies — or the update is refused (422); nothing is coerced
 * to a default.
 */
function buildUpdatedSettings(fromFile, updates) {
  let next = { ...fromFile };

  if (updates.serverName !== undefined) {
    if (updates.serverName !== null && typeof updates.serverName !== 'string') {
      throw createAppError('INVALID_SETTINGS', 'serverName must be a string or null');
    }
    // An empty name clears back to the default display name.
    next.serverName = updates.serverName?.trim() || null;
  }
  for (const key of ['vmsPath', 'imagePath', 'backupLocalPath', 'containersPath']) {
    if (updates[key] === undefined) continue;
    next[key] = checkAbsolutePath(updates[key], key);
    if (isWithin(INSTALL_ROOT, next[key])) {
      throw createAppError('INVALID_SETTINGS', `${key} ${next[key]} is in Wisp's install folder ${INSTALL_ROOT}, and an install replaces what that folder holds: pick a folder outside it`);
    }
  }
  if (updates.backupMountId !== undefined) {
    if (updates.backupMountId === null || updates.backupMountId === '') {
      next.backupMountId = null;
    } else {
      const id = typeof updates.backupMountId === 'string' ? updates.backupMountId.trim() : '';
      if (!next.mounts.some((m) => m.id === id)) {
        throw createAppError('INVALID_SETTINGS', `No mount with id "${updates.backupMountId}"`);
      }
      next.backupMountId = id;
    }
    next = pruneBackupDestinations(next);
  }
  /* After the backupMountId branch on purpose — a PATCH that swaps the backup
   * mount and updates the schedule in one request validates against the new id. */
  if (updates.backupSchedule !== undefined) {
    next.backupSchedule = mergeBackupSchedule(next.backupSchedule, updates.backupSchedule, next.backupMountId);
  }
  if (updates.discoveryEnabled !== undefined) {
    if (typeof updates.discoveryEnabled !== 'boolean') {
      throw createAppError('INVALID_SETTINGS', 'discoveryEnabled must be true or false');
    }
    next.discoveryEnabled = updates.discoveryEnabled;
  }
  if (updates.advertisedUrl !== undefined) next.advertisedUrl = checkAdvertisedUrl(updates.advertisedUrl);
  if (updates.updateChannel !== undefined) next.updateChannel = checkUpdateChannel(updates.updateChannel);
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
  await writeSettingsUnderLock(mutate);
  return getSettings();
}

/** Returns the state the mutator produced, as persisted (null when it wrote nothing). */
async function writeSettingsUnderLock(mutate) {
  const run = writeLock.then(async () => {
    const fromFile = await readSettingsFile();
    const next = await mutate(fromFile);
    if (next) await persistSettings(next);
    return next ?? null;
  });
  // Keep the chain alive past rejections — a throwing mutate (validation) must
  // fail its own caller only, not poison every subsequent settings write.
  writeLock = run.catch(() => { /* the rejection is the caller's (run), not the chain's */ });
  return run;
}

/**
 * Write the state through the same parse the read applies, so the file on disk
 * always passes the next read (and the startup read that gates boot). A state
 * that fails it throws here and nothing is written.
 */
async function persistSettings(state) {
  const toWrite = parseWispConfig({
    serverName: state.serverName,
    vmsPath: state.vmsPath,
    imagePath: state.imagePath,
    backupLocalPath: state.backupLocalPath,
    containersPath: state.containersPath,
    sections: state.sections,
    assignments: state.assignments,
    homepage: state.homepage,
    mounts: state.mounts.map(mountForFile),
    backupMountId: state.backupMountId,
    backupSchedule: state.backupSchedule,
    discoveryEnabled: state.discoveryEnabled,
    advertisedUrl: state.advertisedUrl,
    updateChannel: state.updateChannel,
    oidc: state.oidc,
    trustedProxies: state.trustedProxies,
    apiTokens: state.apiTokens,
    sshKeys: state.sshKeys,
    certificate: state.certificate,
  });
  // 0600: the file holds secrets (SMB passwords, OIDC client secret, the
  // certificate's Cloudflare token). Without an
  // explicit mode the atomic temp file lands at the umask default (usually 0644),
  // silently widening the config back to world-readable on every save.
  await writeJsonAtomic(CONFIG_PATH, toWrite, { mode: 0o600 });
}

/** A mount entry as stored: only its type's fields; an empty SMB password is omitted. */
function mountForFile(d) {
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
    if (d.password) out.password = d.password;
  } else if (d.type === 'disk') {
    out.uuid = d.uuid;
    if (d.fsType) out.fsType = d.fsType;
    out.readOnly = d.readOnly === true;
  }
  return out;
}

/**
 * API tokens as stored (hashes included). Server-side only — the auth hook
 * verifies bearer tokens against these; the UI lists them via lib/apiTokens.js
 * which strips the hashes. Never part of getSettings().
 */
export async function getRawApiTokens() {
  const fromFile = await readSettingsFile();
  return fromFile.apiTokens;
}

/**
 * Home page overlay as stored. Deliberately outside `getSettings()`: it is
 * managed exclusively via `/api/homepage` (never `PATCH /api/settings`) and
 * the client reads it through the `home` topic's derived envelope, not the
 * settings payload.
 */
export async function getRawHomepage() {
  const fromFile = await readSettingsFile();
  return fromFile.homepage;
}

/**
 * The host certificate's setting as stored, its token included, or null.
 * Server-side only: the certificate glue (lib/hostCertificate.js) reads it and
 * answers the record without the token. Never part of getSettings().
 */
export async function getRawCertificateSetting() {
  const fromFile = await readSettingsFile();
  return fromFile.certificate;
}

/**
 * Write the certificate setting through `mutate(current) → next` (null
 * removes it) under the settings write lock. It is not among what
 * getSettings() returns, so no settings cue: the certificate glue announces
 * its own. Resolves the setting as written.
 */
export async function writeCertificateSetting(mutate) {
  const written = await writeSettingsUnderLock(async (fromFile) => ({
    ...fromFile,
    certificate: await mutate(fromFile.certificate),
  }));
  return written.certificate;
}

/**
 * Return mounts as stored (including SMB passwords). For server-side use only (e.g. mount, auto-mount).
 */
export async function getRawMounts() {
  const fromFile = await readSettingsFile();
  return fromFile.mounts;
}

/** Refuse a mount path another mount already has: the read's rule (mountOnPath), as the API's 409. */
function assertMountPathFree(mounts, mountPath, ownId) {
  const other = mountOnPath(mounts, mountPath, ownId);
  if (other) {
    throw createAppError('MOUNT_DUPLICATE', `Mount "${other.label || other.id}" already uses ${mountPath}`);
  }
}

function mountEntryFromBody(body, id) {
  const type = body.type === 'smb' || body.type === 'disk' ? body.type : null;
  if (!type) {
    throw createAppError('MOUNT_INVALID', 'type must be "smb" or "disk"');
  }
  const mountPath = checkMountPath(body.mountPath);
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  const autoMount = body.autoMount !== false;
  const entry = { id, type, label: label || id.slice(0, 8), mountPath, autoMount };
  if (type === 'smb') {
    if (typeof body.share !== 'string' || !body.share.trim()) {
      throw createAppError('MOUNT_INVALID', 'share is required for smb mounts');
    }
    entry.share = checkShare(body.share);
    entry.username = typeof body.username === 'string' ? body.username.trim() : '';
    entry.password = typeof body.password === 'string' ? body.password : '';
  } else {
    const uuid = typeof body.uuid === 'string' ? body.uuid.trim() : '';
    if (!uuid) {
      throw createAppError('MOUNT_INVALID', 'uuid is required for disk mounts');
    }
    entry.uuid = uuid;
    if (body.fsType !== undefined) entry.fsType = checkFsType(body.fsType);
    entry.readOnly = body.readOnly === true;
  }
  return entry;
}

/**
 * Append one mount. Returns `{ id, mounts }`: the new mount's id, and the mounts
 * as written, shaped as getSettings() shows them.
 */
export async function addMount(body) {
  if (!body || typeof body !== 'object') {
    throw createAppError('MOUNT_INVALID', 'Body must be a JSON object');
  }
  const id =
    typeof body.id === 'string' && body.id.trim() ? body.id.trim() : randomUUID();
  const written = await commitSettings((fromFile) => {
    const existing = fromFile.mounts || [];
    if (existing.some((m) => m.id === id)) {
      throw createAppError('MOUNT_DUPLICATE', `Mount "${id}" already exists`);
    }
    const entry = mountEntryFromBody(body, id);
    assertMountPathFree(existing, entry.mountPath, id);
    return { ...fromFile, mounts: [...existing, entry] };
  });
  announceMountsChange();
  return { id, mounts: written.mounts.map(mountForApi) };
}

/**
 * Update one mount by id. Only label, mountPath, autoMount, and type-specific fields can change.
 * Type cannot be changed after creation.
 */
export async function updateMount(mountId, body) {
  if (!body || typeof body !== 'object') {
    throw createAppError('MOUNT_INVALID', 'Body must be a JSON object');
  }
  const written = await commitSettings((fromFile) => {
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
      cur.mountPath = checkMountPath(body.mountPath);
      assertMountPathFree(list, cur.mountPath, mountId);
    }
    if (body.autoMount !== undefined) {
      cur.autoMount = body.autoMount !== false;
    }
    if (cur.type === 'smb') {
      if (body.share !== undefined) {
        if (typeof body.share !== 'string' || !body.share.trim()) {
          throw createAppError('MOUNT_INVALID', 'share cannot be empty for smb mounts');
        }
        cur.share = checkShare(body.share);
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
      if (body.fsType !== undefined) cur.fsType = checkFsType(body.fsType);
      if (body.readOnly !== undefined) {
        cur.readOnly = body.readOnly === true;
      }
    }
    list[idx] = cur;
    return { ...fromFile, mounts: list };
  });
  announceMountsChange();
  return { mounts: written.mounts.map(mountForApi) };
}

/**
 * Remove one mount. When it was the backup mount, clears backupMountId and
 * drops it from the schedule's destinations, in the same write.
 */
export async function removeMount(mountId) {
  const written = await commitSettings((fromFile) => {
    const existing = fromFile.mounts || [];
    const list = existing.filter((m) => m.id !== mountId);
    if (list.length === existing.length) {
      throw createAppError('MOUNT_NOT_FOUND', `No mount with id "${mountId}"`);
    }
    return pruneBackupDestinations({
      ...fromFile,
      mounts: list,
      backupMountId: fromFile.backupMountId === mountId ? null : fromFile.backupMountId,
    });
  });
  announceMountsChange();
  return { mounts: written.mounts.map(mountForApi) };
}

// ─── SSH keys ───────────────────────────────────

/** A key as `GET /api/settings` shows it: as stored, with its type and fingerprint. */
function sshKeyForApi(k) {
  const read = readSshKey(k.key);
  return { id: k.id, name: k.name, key: k.key, default: k.default, type: read.type, fingerprint: sshKeyFingerprint(read) };
}

/** Refuse a key already in the list (the same type and data), naming the one it is. */
function assertNotListed(list, read) {
  const same = list.find((k) => readSshKey(k.key).identity === read.identity);
  if (same) throw createAppError('SSH_KEY_DUPLICATE', `This key is already in Wisp's list, as "${same.name}"`);
}

const sshKeyNotFound = (id) => createAppError('SSH_KEY_NOT_FOUND', `No SSH key with id "${id}" in Wisp's list`);

function assertRoomFor(list, count) {
  if (list.length + count > MAX_SSH_KEYS) {
    throw createAppError('INVALID_REQUEST', `Wisp's list holds at most ${MAX_SSH_KEYS} SSH keys`);
  }
}

/**
 * Add one public key to Wisp's list, not as a default. Its name is `name` when one is
 * given, else the key's comment, else one from its type. Returns `{ id }`.
 */
export async function addSshKey({ key, name }) {
  const read = parseSshKey(key);
  const given = typeof name === 'string' && name.trim() ? validSshKeyName(name) : null;
  if (typeof name === 'string' && name.trim() && !given) {
    throw createAppError('INVALID_REQUEST', 'A key’s name is up to 64 characters, with no control characters');
  }
  const id = randomUUID();
  await commitSettings((fromFile) => {
    assertNotListed(fromFile.sshKeys, read);
    assertRoomFor(fromFile.sshKeys, 1);
    const entry = { id, name: given ?? defaultSshKeyName(read), key: read.key, default: false };
    return { ...fromFile, sshKeys: [...fromFile.sshKeys, entry] };
  });
  return { id };
}

/**
 * Add a GitHub user's keys (`keys`, the lines GitHub lists) to Wisp's list, named
 * "<user> on GitHub", "<user> on GitHub 2" and so on. A key already in the list is
 * skipped and counted, and so is a line that is no key Wisp takes (unreadable, or of a
 * type it does not take). Returns `{ added, alreadyListed, skipped }`, `added` the new
 * keys' ids.
 */
export async function importSshKeys(user, keys) {
  const reads = keys.map(readSshKey).filter((read) => !read.problem);
  const skipped = keys.length - reads.length;
  let result = { added: [], alreadyListed: 0, skipped };
  await commitSettings((fromFile) => {
    const listed = new Set(fromFile.sshKeys.map((k) => readSshKey(k.key).identity));
    const fresh = [];
    let alreadyListed = 0;
    for (const read of reads) {
      if (listed.has(read.identity)) alreadyListed += 1;
      else {
        listed.add(read.identity);
        fresh.push(read);
      }
    }
    result = { added: [], alreadyListed, skipped };
    if (fresh.length === 0) return null;
    assertRoomFor(fromFile.sshKeys, fresh.length);
    const entries = fresh.map((read, i) => ({
      id: randomUUID(),
      name: `${user} on GitHub${i === 0 ? '' : ` ${i + 1}`}`.slice(0, 64),
      key: read.key,
      default: false,
    }));
    result = { added: entries.map((e) => e.id), alreadyListed, skipped };
    return { ...fromFile, sshKeys: [...fromFile.sshKeys, ...entries] };
  });
  return result;
}

/** Rename a key of Wisp's list, or make it a default for new VMs or not (either alone, or both). */
export async function updateSshKey(id, { name, default: isDefault }) {
  let newName;
  if (name !== undefined) {
    newName = validSshKeyName(name);
    if (!newName) throw createAppError('INVALID_REQUEST', 'A key’s name is 1 to 64 characters, with no control characters');
  }
  await commitSettings((fromFile) => {
    if (!fromFile.sshKeys.some((k) => k.id === id)) throw sshKeyNotFound(id);
    return {
      ...fromFile,
      sshKeys: fromFile.sshKeys.map((k) => (k.id !== id ? k : {
        ...k,
        ...(newName !== undefined ? { name: newName } : {}),
        ...(isDefault !== undefined ? { default: isDefault } : {}),
      })),
    };
  });
}

/** Remove a key from Wisp's list. No VM changes: each keeps its own copy. */
export async function removeSshKey(id) {
  await commitSettings((fromFile) => {
    if (!fromFile.sshKeys.some((k) => k.id === id)) throw sshKeyNotFound(id);
    return { ...fromFile, sshKeys: fromFile.sshKeys.filter((k) => k.id !== id) };
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
