/**
 * Container bind mount definitions: validation and bind-source checks.
 * Supports two kinds of directory sources:
 *   - Local  (default) — backing store lives under <containersPath>/<name>/files/<mountName>
 *   - Storage — backing store lives at <storageMount.mountPath>/<subPath>,
 *               where storageMount is an entry in settings.mounts (SMB share / removable drive).
 * File mounts are always Local, and may be `secret: true` — content write-only (never read back).
 *
 * A third type — `tmpfs` — has no host backing at all: contents live only in kernel memory
 * for the lifetime of the container task and are gone on stop/restart. tmpfs entries carry
 * a sizeMiB cap (default 64) and ignore sourceId/subPath/readonly/containerOwnerUid/Gid.
 */
import { basename, join, resolve } from 'node:path';
import { lstat, mkdir, stat, writeFile, realpath } from 'node:fs/promises';

import { containerError } from './containerManagerConnection.js';
import { getContainerFilesDir } from './containerPaths.js';
import { getMountStatus } from '../../storage/index.js';

/**
 * @param {string} name
 * @returns {string|null} normalized segment or null if invalid
 */
export function validateMountSegmentName(name) {
  if (!name || typeof name !== 'string') return null;
  const t = name.trim();
  if (t.includes('/') || t.includes('\\') || t.includes('..')) return null;
  if (t.startsWith('.')) return null;
  if (t !== basename(t)) return null;
  return t;
}

/**
 * Validate a sub-path (relative, no `..`, no leading `/`). Empty string is allowed (means mount root).
 * @param {unknown} value
 * @returns {string|null} normalized sub-path (no leading/trailing slashes) or null if invalid
 */
export function validateSubPath(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return '';
  if (trimmed.startsWith('/')) return null;
  const segments = trimmed.split('/').filter((s) => s.length > 0);
  for (const seg of segments) {
    if (seg === '..' || seg === '.') return null;
  }
  return segments.join('/');
}

/**
 * Resolve the host-side bind-mount source path for a single mount entry.
 * @param {{ type: string, name: string, sourceId?: string|null, subPath?: string }} mount
 * @param {string} filesDir - absolute path to <containersPath>/<name>/files/
 * @param {(id: string) => null | { id: string, mountPath: string, label?: string }} [resolveMount] - storage-mount resolver supplied via configure()
 * @returns {{ source: 'local'|'storage', hostPath: string, storageMount?: object }}
 */
export function resolveMountHostPath(mount, filesDir, resolveMount = null) {
  if (!mount || !mount.name) {
    throw containerError('INVALID_CONTAINER_MOUNTS', 'Mount is missing name');
  }
  if (mount.sourceId) {
    const storage = typeof resolveMount === 'function' ? resolveMount(mount.sourceId) : null;
    if (!storage) {
      throw containerError(
        'CONTAINER_MOUNT_SOURCE_MISSING',
        `Mount "${mount.name}" references storage mount "${mount.sourceId}" which is no longer configured`,
      );
    }
    const sub = mount.subPath || '';
    const hostPath = sub ? join(storage.mountPath, sub) : storage.mountPath;
    return { source: 'storage', hostPath, storageMount: storage };
  }
  return { source: 'local', hostPath: join(filesDir, mount.name) };
}

/**
 * Validate an integer in [0, 65535] (a valid POSIX UID/GID for our purposes).
 * @param {unknown} value
 * @returns {number|null} the integer or null if invalid
 */
export function validateOwnerId(value) {
  if (value === undefined || value === null || value === '') return 0;
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (!Number.isInteger(n) || n < 0 || n > 65535) return null;
  return n;
}

/** Default and max tmpfs cap (MiB). Values are kept conservative to avoid eating host RAM. */
export const TMPFS_DEFAULT_SIZE_MIB = 64;
export const TMPFS_MAX_SIZE_MIB = 2048;

/**
 * Validate a tmpfs sizeMiB value. Accepts undefined/null/'' as "use default".
 * @param {unknown} value
 * @returns {number|null} the integer (default-applied) or null if invalid
 */
export function validateTmpfsSizeMiB(value) {
  if (value === undefined || value === null || value === '') return TMPFS_DEFAULT_SIZE_MIB;
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (!Number.isInteger(n) || n < 1 || n > TMPFS_MAX_SIZE_MIB) return null;
  return n;
}

/**
 * Validate a mount's `secret` flag: a boolean (absent/null = false), and only a file mount
 * may be secret — its content is write-only (see getMountFileTextContent). Persisted only
 * when true.
 * @param {unknown} value
 * @param {string} type - mount type
 * @returns {boolean}
 */
export function validateSecretFlag(value, type) {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') {
    throw containerError('INVALID_CONTAINER_MOUNTS', 'secret must be a boolean');
  }
  if (value && type !== 'file') {
    throw containerError('INVALID_CONTAINER_MOUNTS', 'secret is only allowed on file mounts');
  }
  return value;
}

/**
 * Validate and normalize mounts for persistence. Rejects duplicate name or containerPath.
 * When `resolveMount` is provided, validates that every `sourceId` resolves to a real mount.
 * @param {unknown} mounts
 * @param {((id: string) => null | { id: string, mountPath: string, label?: string }) | null} [resolveMount]
 * @returns {Array<
 *   | { type: 'file'|'directory', name: string, containerPath: string, readonly: boolean, sourceId: string|null, subPath: string, containerOwnerUid: number, containerOwnerGid: number, secret?: true }
 *   | { type: 'tmpfs', name: string, containerPath: string, sizeMiB: number }
 * >}
 */
export function validateAndNormalizeMounts(mounts, resolveMount = null) {
  if (!Array.isArray(mounts)) {
    throw containerError('INVALID_CONTAINER_MOUNTS', 'mounts must be an array');
  }
  const names = new Set();
  const containerPaths = new Set();
  const out = [];
  for (const raw of mounts) {
    if (!raw || typeof raw !== 'object') {
      throw containerError('INVALID_CONTAINER_MOUNTS', 'Each mount must be an object');
    }
    const type = raw.type;
    if (type !== 'file' && type !== 'directory' && type !== 'tmpfs') {
      throw containerError('INVALID_CONTAINER_MOUNTS', 'Mount type must be "file", "directory", or "tmpfs"');
    }
    const seg = validateMountSegmentName(raw.name);
    if (!seg) {
      throw containerError('INVALID_CONTAINER_MOUNTS', 'Invalid mount name');
    }
    const containerPath = typeof raw.containerPath === 'string' ? raw.containerPath.trim() : '';
    if (!containerPath.startsWith('/') || containerPath.length < 2) {
      throw containerError('INVALID_CONTAINER_MOUNTS', 'containerPath must be an absolute path');
    }
    if (names.has(seg)) {
      throw containerError('CONTAINER_MOUNT_DUPLICATE', `Duplicate mount name "${seg}"`);
    }
    names.add(seg);
    if (containerPaths.has(containerPath)) {
      throw containerError('CONTAINER_MOUNT_DUPLICATE', `Duplicate container path "${containerPath}"`);
    }
    containerPaths.add(containerPath);

    if (type === 'tmpfs') {
      // tmpfs has no host backing — sourceId/subPath/readonly/containerOwnerUid/Gid don't apply.
      // Reject them explicitly so misuse surfaces instead of being silently dropped.
      if (raw.sourceId !== undefined && raw.sourceId !== null && raw.sourceId !== '') {
        throw containerError('INVALID_CONTAINER_MOUNTS', 'sourceId is not allowed on tmpfs mounts');
      }
      if (raw.subPath !== undefined && raw.subPath !== null && raw.subPath !== '') {
        throw containerError('INVALID_CONTAINER_MOUNTS', 'subPath is not allowed on tmpfs mounts');
      }
      if (raw.readonly === true) {
        throw containerError('INVALID_CONTAINER_MOUNTS', 'tmpfs mounts cannot be read-only');
      }
      validateSecretFlag(raw.secret, type);
      if (raw.containerOwnerUid !== undefined && raw.containerOwnerUid !== null && raw.containerOwnerUid !== '' && raw.containerOwnerUid !== 0) {
        throw containerError('INVALID_CONTAINER_MOUNTS', 'containerOwnerUid is not applicable to tmpfs mounts');
      }
      if (raw.containerOwnerGid !== undefined && raw.containerOwnerGid !== null && raw.containerOwnerGid !== '' && raw.containerOwnerGid !== 0) {
        throw containerError('INVALID_CONTAINER_MOUNTS', 'containerOwnerGid is not applicable to tmpfs mounts');
      }
      const sizeMiB = validateTmpfsSizeMiB(raw.sizeMiB);
      if (sizeMiB === null) {
        throw containerError(
          'INVALID_CONTAINER_MOUNTS',
          `sizeMiB must be an integer in [1, ${TMPFS_MAX_SIZE_MIB}]`,
        );
      }
      out.push({ type: 'tmpfs', name: seg, containerPath, sizeMiB });
      continue;
    }

    let sourceId = null;
    let subPath = '';
    if (raw.sourceId !== undefined && raw.sourceId !== null && raw.sourceId !== '') {
      if (type !== 'directory') {
        throw containerError('INVALID_CONTAINER_MOUNTS', 'sourceId is only allowed on directory mounts');
      }
      if (typeof raw.sourceId !== 'string' || !raw.sourceId.trim()) {
        throw containerError('INVALID_CONTAINER_MOUNTS', 'sourceId must be a non-empty string');
      }
      sourceId = raw.sourceId.trim();
      if (typeof resolveMount === 'function') {
        if (!resolveMount(sourceId)) {
          throw containerError(
            'INVALID_CONTAINER_MOUNTS',
            `sourceId "${sourceId}" does not reference a configured storage mount`,
          );
        }
      }
      const normalizedSub = validateSubPath(raw.subPath);
      if (normalizedSub === null) {
        throw containerError('INVALID_CONTAINER_MOUNTS', 'subPath must be relative and must not contain ".." segments');
      }
      subPath = normalizedSub;
    }

    const secret = validateSecretFlag(raw.secret, type);

    const containerOwnerUid = validateOwnerId(raw.containerOwnerUid);
    if (containerOwnerUid === null) {
      throw containerError('INVALID_CONTAINER_MOUNTS', 'containerOwnerUid must be an integer in [0, 65535]');
    }
    const containerOwnerGid = validateOwnerId(raw.containerOwnerGid);
    if (containerOwnerGid === null) {
      throw containerError('INVALID_CONTAINER_MOUNTS', 'containerOwnerGid must be an integer in [0, 65535]');
    }

    out.push({
      type,
      name: seg,
      containerPath,
      readonly: raw.readonly === true,
      sourceId,
      subPath,
      containerOwnerUid,
      containerOwnerGid,
      ...(secret ? { secret: true } : {}),
    });
  }
  return out;
}

/**
 * @param {object} config - container.json
 * @param {string} mountName
 * @returns {{ type: string, name: string, containerPath: string, readonly: boolean, sourceId?: string|null, subPath?: string } | null}
 */
export function findMount(config, mountName) {
  const list = config.mounts;
  if (!Array.isArray(list)) return null;
  return list.find((m) => m.name === mountName) ?? null;
}

/**
 * Create an empty file or directory for a Local mount if the artifact path is missing.
 * Storage-sourced and tmpfs mounts are skipped — Storage artifacts are managed at start time
 * (mkdir -p of subPath); tmpfs has no host backing at all.
 * @param {string} containerName
 * @param {{ type: string, name: string, sourceId?: string|null }} mountEntry
 */
export async function ensureMountArtifactIfMissing(containerName, mountEntry) {
  if (mountEntry.type === 'tmpfs') return;
  if (mountEntry.sourceId) return;
  const filesDir = getContainerFilesDir(containerName);
  await mkdir(filesDir, { recursive: true });
  const root = resolve(filesDir);
  const hostPath = resolve(join(filesDir, mountEntry.name));
  if (!hostPath.startsWith(root + '/') && hostPath !== root) {
    throw containerError('CONTAINERD_ERROR', `Invalid mount path for "${mountEntry.name}"`);
  }
  try {
    await stat(hostPath);
    return;
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  if (mountEntry.type === 'file') {
    await writeFile(hostPath, Buffer.alloc(0));
  } else {
    await mkdir(hostPath, { recursive: true });
  }
}

/**
 * @param {string} containerName
 * @param {{ type: string, name: string, sourceId?: string|null }[]} mounts
 */
export async function ensureMissingMountArtifacts(containerName, mounts) {
  if (!Array.isArray(mounts) || mounts.length === 0) return;
  for (const m of mounts) {
    await ensureMountArtifactIfMissing(containerName, m);
  }
}

async function assertBindSourcesReadyLocal(containerName, m, filesDir) {
  const root = resolve(filesDir);
  const hostPath = resolve(join(filesDir, m.name));
  if (!hostPath.startsWith(root + '/') && hostPath !== root) {
    throw containerError('CONTAINERD_ERROR', `Invalid mount path for "${m.name}"`);
  }
  try {
    const s = await stat(hostPath);
    if (m.type === 'file' && !s.isFile()) {
      throw containerError(
        'CONTAINER_MOUNT_SOURCE_WRONG_TYPE',
        `Mount "${m.name}" must be backed by a file on the host`,
      );
    }
    if (m.type === 'directory' && !s.isDirectory()) {
      throw containerError(
        'CONTAINER_MOUNT_SOURCE_WRONG_TYPE',
        `Mount "${m.name}" must be backed by a directory on the host`,
      );
    }
  } catch (err) {
    if (typeof err?.code === 'string' && err.code.startsWith('CONTAINER_')) throw err;
    if (err?.code === 'ENOENT') {
      await ensureMountArtifactIfMissing(containerName, m);
      const s = await stat(hostPath);
      if (m.type === 'file' && !s.isFile()) {
        throw containerError(
          'CONTAINER_MOUNT_SOURCE_WRONG_TYPE',
          `Mount "${m.name}" must be backed by a file on the host`,
        );
      }
      if (m.type === 'directory' && !s.isDirectory()) {
        throw containerError(
          'CONTAINER_MOUNT_SOURCE_WRONG_TYPE',
          `Mount "${m.name}" must be backed by a directory on the host`,
        );
      }
      return;
    }
    throw err;
  }
}

function isInsideRoot(path, root) {
  return path === root || path.startsWith(root + '/');
}

function unsafeMountError(m, detail) {
  return containerError(
    'CONTAINER_MOUNT_SOURCE_UNSAFE',
    `Mount "${m.name}" resolves outside its storage root — symlink escape rejected`,
    detail,
  );
}

/**
 * The configured, currently mounted storage root for a Storage-sourced mount,
 * as both its configured path and its realpath.
 */
async function storageRootForMount(m, resolveMount) {
  const storage = typeof resolveMount === 'function' ? resolveMount(m.sourceId) : null;
  if (!storage) {
    throw containerError(
      'CONTAINER_MOUNT_SOURCE_MISSING',
      `Mount "${m.name}" references storage mount "${m.sourceId}" which is no longer configured`,
    );
  }
  const { mounted } = await getMountStatus(storage.mountPath);
  if (!mounted) {
    throw containerError(
      'CONTAINER_MOUNT_SOURCE_NOT_MOUNTED',
      `Mount "${m.name}" points at storage "${storage.label || storage.id}" which is not currently mounted at ${storage.mountPath}. Mount it in Host Mgmt → Storage, then retry.`,
    );
  }
  let resolvedRoot;
  try {
    resolvedRoot = await realpath(storage.mountPath);
  } catch (err) {
    throw containerError('CONTAINER_MOUNT_SOURCE_UNSAFE', `Could not resolve mount source for "${m.name}"`, err.message);
  }
  return { storage, resolvedRoot };
}

/**
 * Create a Storage mount's subPath one component at a time from the resolved
 * root, checking each existing component before anything is created under
 * it: a symlink is followed only when its target stays inside the root, so no
 * directory is ever created outside it. Returns the resolved path.
 */
async function mkdirSubPathInsideRoot(m, resolvedRoot) {
  let current = resolvedRoot;
  for (const seg of (m.subPath || '').split('/').filter(Boolean)) {
    const next = join(current, seg);
    let info;
    try {
      info = await lstat(next);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
      try {
        await mkdir(next);
      } catch (mkErr) {
        if (mkErr?.code !== 'EEXIST') throw mkErr;
      }
      info = await lstat(next);
    }
    if (info.isSymbolicLink()) {
      let target;
      try {
        target = await realpath(next);
      } catch (err) {
        throw unsafeMountError(m, `${next}: ${err.message}`);
      }
      if (!isInsideRoot(target, resolvedRoot)) throw unsafeMountError(m, `${next} → ${target}`);
      current = target;
      continue;
    }
    if (!info.isDirectory()) {
      throw containerError(
        'CONTAINER_MOUNT_SOURCE_WRONG_TYPE',
        `Mount "${m.name}" storage path ${next} is not a directory`,
      );
    }
    current = next;
  }
  return current;
}

/** Realpath a Storage mount's source and require it to be a directory inside its root. */
async function resolveStorageSource(m, resolveMount) {
  const { storage, resolvedRoot } = await storageRootForMount(m, resolveMount);
  const sub = m.subPath || '';
  const hostPath = sub ? join(storage.mountPath, sub) : storage.mountPath;
  let resolvedHost;
  try {
    resolvedHost = await realpath(hostPath);
  } catch (err) {
    throw containerError('CONTAINER_MOUNT_SOURCE_UNSAFE', `Could not resolve mount source for "${m.name}"`, err.message);
  }
  if (!isInsideRoot(resolvedHost, resolvedRoot)) throw unsafeMountError(m, `${hostPath} → ${resolvedHost}`);
  const s = await stat(resolvedHost);
  if (!s.isDirectory()) {
    throw containerError(
      'CONTAINER_MOUNT_SOURCE_WRONG_TYPE',
      `Mount "${m.name}" storage path ${hostPath} is not a directory`,
    );
  }
  return resolvedHost;
}

async function assertBindSourcesReadyStorage(m, resolveMount) {
  const { resolvedRoot } = await storageRootForMount(m, resolveMount);
  await mkdirSubPathInsideRoot(m, resolvedRoot);
  await resolveStorageSource(m, resolveMount);
}

/** Realpath a Local mount's backing file/dir and require it inside files/ with the right type. */
async function resolveLocalSource(m, filesDir) {
  let resolvedRoot;
  let resolvedHost;
  try {
    resolvedRoot = await realpath(filesDir);
    resolvedHost = await realpath(join(filesDir, m.name));
  } catch (err) {
    throw containerError('CONTAINER_MOUNT_SOURCE_MISSING', `Mount "${m.name}" has no backing ${m.type} on the host`, err.message);
  }
  if (!isInsideRoot(resolvedHost, resolvedRoot) || resolvedHost === resolvedRoot) {
    throw containerError('CONTAINER_MOUNT_SOURCE_UNSAFE', `Mount "${m.name}" resolves outside the container's files directory`);
  }
  const s = await stat(resolvedHost);
  if ((m.type === 'file' && !s.isFile()) || (m.type === 'directory' && !s.isDirectory())) {
    throw containerError(
      'CONTAINER_MOUNT_SOURCE_WRONG_TYPE',
      `Mount "${m.name}" must be backed by a ${m.type} on the host`,
    );
  }
  return resolvedHost;
}

/**
 * Resolve every bind mount's host source to its real path and re-check it
 * against its root (files/ for Local, the storage mount for Storage) — the
 * check-to-use window is what a symlink swap would exploit, so this runs
 * immediately before task create, and its result is what the OCI spec binds
 * (`buildOCISpec` opts.mountSources). Creates nothing: `assertBindSourcesReady`
 * already made the artifacts at the start of the start.
 * @returns {Promise<Map<string, string>>} mount name → resolved host path
 */
export async function resolveBindSources(config, filesDir, resolveMount = null) {
  const out = new Map();
  for (const m of Array.isArray(config.mounts) ? config.mounts : []) {
    if (m?.type !== 'file' && m?.type !== 'directory') continue;
    out.set(m.name, m.sourceId
      ? await resolveStorageSource(m, resolveMount)
      : await resolveLocalSource(m, filesDir));
  }
  return out;
}

/**
 * Ensure each mount's backing path exists and matches type (early in a start, before the
 * network wait). Local mounts auto-create the artifact under files/. Storage mounts verify the
 * referenced storage is currently mounted and create the sub-path inside the storage root,
 * never following a symlink out of it. `resolveBindSources` re-checks right before task create.
 * @param {string} containerName
 * @param {object} config
 * @param {string} filesDir - absolute path to container files/
 * @param {((id: string) => null | { id: string, mountPath: string, label?: string }) | null} [resolveMount]
 */
export async function assertBindSourcesReady(containerName, config, filesDir, resolveMount = null) {
  const list = config.mounts;
  if (!Array.isArray(list) || list.length === 0) return;
  for (const m of list) {
    if (m.type === 'tmpfs') continue;
    if (m.sourceId) {
      await assertBindSourcesReadyStorage(m, resolveMount);
    } else {
      await assertBindSourcesReadyLocal(containerName, m, filesDir);
    }
  }
}
