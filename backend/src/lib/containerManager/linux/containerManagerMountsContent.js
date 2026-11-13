/**
 * Backing store for container mounts under files/<mountName>: upload, zip check and extract, init, rename, delete,
 * text read/write (refused for secret mounts), clear.
 *
 * A stored `secret: true` file mount's backing file is always SECRET_MOUNT_FILE_MODE (0600):
 * every write path tightens an existing file before writing to it and creates a new one at
 * that mode, marking a mount secret tightens its file (`tightenSecretMountFiles`), and
 * un-marking empties it and puts it back to the plain-file mode (`clearMountBackingFile`).
 */
import { join, resolve } from 'node:path';
import { chmod, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { execFile as execFileCb, spawn } from 'node:child_process';
import { TextDecoder, TextEncoder } from 'node:util';

import { containerError } from './containerManagerConnection.js';
import { getContainerDir, getContainerFilesDir } from './containerPaths.js';
import { findMount, validateMountSegmentName, SECRET_MOUNT_FILE_MODE } from './containerManagerMounts.js';
import { createStallWatchdog, processReadProbe, stallMinutes } from '../../storage/index.js';
import { atomicTmpName } from './atomicJson.js';

/** Same contract as `import { execFile } from 'node:child_process/promises'` (avoids subpath builtin issues on some runtimes). */
function execFile(command, args, options) {
  return new Promise((resolve, reject) => {
    execFileCb(command, args, options, (err, stdout, stderr) => {
      if (err) {
        Object.assign(err, { stderr });
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function loadContainerJson(containerName) {
  const p = join(getContainerDir(containerName), 'container.json');
  let raw;
  try {
    raw = await readFile(p, 'utf8');
  } catch {
    throw containerError('CONTAINER_NOT_FOUND', `Container "${containerName}" not found`);
  }
  return JSON.parse(raw);
}

function artifactPath(containerName, mountName) {
  return join(getContainerFilesDir(containerName), mountName);
}

/**
 * Mode a plain mount file gets when Wisp creates it: 0666 under the process umask —
 * 0644 under the service's default umask 022. What un-marking a secret restores.
 */
function plainMountFileMode() {
  return 0o666 & ~process.umask();
}

/**
 * The mode a write must leave a file mount's backing file at: SECRET_MOUNT_FILE_MODE for
 * a stored secret, else the caller's `mode` (undefined = keep an existing file's mode).
 */
function mountFileWriteMode(mount, mode) {
  return mount.secret === true ? SECRET_MOUNT_FILE_MODE : mode;
}

/**
 * chmod a file if it exists. Write paths call it before replacing the content, so new
 * content never sits under a wider mode; a missing file is fine — the write that follows
 * creates it with `mode`.
 */
async function chmodIfExists(p, mode) {
  try {
    await chmod(p, mode);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

/** The refusal for reading a secret file mount's content — write-only for every caller. */
export function mountSecretError(mountName) {
  return containerError(
    'CONTAINER_MOUNT_SECRET',
    `Mount "${mountName}" is secret`,
    'Secret file content is write-only — it can be replaced or cleared, never read back',
  );
}

/** Max size for GET/PUT mount file text editor (UTF-8 bytes). */
export const MOUNT_FILE_CONTENT_MAX_BYTES = 512 * 1024;

function isUnzipMissingError(err) {
  return err?.code === 'ENOENT' || err?.errno === 'ENOENT';
}

/**
 * Plan an upload to files/<mountName> (a file mount): `tmp` is a temp file
 * beside the destination (same filesystem, the atomic-write suffix boot
 * cleanup sweeps) that the caller streams the upload into, created at
 * `mode`, then `commitMountFileUpload` renames over the destination — an
 * atomic replace, the old content intact until then. A secret mount's file
 * is created at SECRET_MOUNT_FILE_MODE. The caller removes `tmp` on failure.
 */
export async function planMountFileUpload(containerName, mountName) {
  const config = await loadContainerJson(containerName);
  const m = findMount(config, mountName);
  if (!m) {
    throw containerError('CONTAINER_MOUNT_NOT_FOUND', `No mount named "${mountName}"`);
  }
  if (m.type !== 'file') {
    throw containerError('CONTAINER_MOUNT_TYPE_MISMATCH', `Mount "${mountName}" is not a file mount`);
  }
  await mkdir(getContainerFilesDir(containerName), { recursive: true });
  const dest = artifactPath(containerName, mountName);
  return { name: mountName, dest, tmp: atomicTmpName(dest), mode: mountFileWriteMode(m, undefined) ?? 0o666 };
}

/** Put a planned upload in place (rename over the destination). */
export async function commitMountFileUpload({ name, dest, tmp }) {
  await rename(tmp, dest);
  const s = await stat(dest);
  return { name, size: s.size, modified: s.mtime.toISOString() };
}

const UNZIP_MAX_LIST = 50 * 1024 * 1024;
/**
 * An extract runs as long as the archive is big: no total bound, but it is
 * stopped after UNZIP_STALL_MS with neither an output line (unzip names each
 * file it inflates) nor bytes read (CODING-RULES §6).
 */
const UNZIP_STALL_MS = 5 * 60_000;

/**
 * List archive entry names with Info-ZIP `unzip -Z1`, reject zip-slip paths before extraction.
 */
async function assertZipPathsSafe(zipPath) {
  let stdout;
  try {
    const r = await execFile('unzip', ['-Z1', zipPath], { maxBuffer: UNZIP_MAX_LIST, timeout: 30_000 }); // a listing: seconds (CODING-RULES §6)
    stdout = r.stdout;
  } catch (err) {
    if (isUnzipMissingError(err)) {
      throw containerError(
        'CONTAINER_ZIP_INVALID',
        'The unzip program is not available (install the unzip package)',
        err.message,
      );
    }
    throw containerError('CONTAINER_ZIP_INVALID', 'Invalid or corrupted zip archive', err.stderr || err.message);
  }
  const lines = String(stdout).split(/\r?\n/).filter((l) => l.length > 0);
  for (const line of lines) {
    const norm = line.replace(/\\/g, '/');
    if (norm.startsWith('/') || /^[A-Za-z]:[\\/]/.test(norm)) {
      throw containerError('CONTAINER_ZIP_UNSAFE', 'Zip contains absolute paths');
    }
    const parts = norm.split('/').filter(Boolean);
    if (parts.some((p) => p === '..')) {
      throw containerError('CONTAINER_ZIP_UNSAFE', 'Zip contains unsafe path segments');
    }
  }
}

/**
 * Extract with system `unzip` into destDir (must exist). Exit 1 = warnings only (accepted).
 */
function extractZipWithUnzipCli(zipPath, destDirAbs) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('unzip', ['-o', zipPath, '-d', destDirAbs], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const watchdog = createStallWatchdog({
      stallMs: UNZIP_STALL_MS,
      probe: processReadProbe(child.pid),
      onStall: () => child.kill('SIGKILL'),
    });
    child.stdout.on('data', watchdog.poke);
    child.stderr.on('data', (d) => { watchdog.poke(); stderr = (stderr + d).slice(-4096); });
    child.on('error', (err) => {
      watchdog.stop();
      if (isUnzipMissingError(err)) {
        reject(containerError('CONTAINER_ZIP_INVALID', 'The unzip program is not available (install the unzip package)', err.message));
      } else {
        reject(containerError('CONTAINER_ZIP_INVALID', 'Failed to extract zip archive', err.message));
      }
    });
    child.on('close', (code) => {
      watchdog.stop();
      if (watchdog.fired) {
        // Not the archive's fault: a server-side failure, not CONTAINER_ZIP_INVALID.
        reject(containerError('CONTAINER_ZIP_EXTRACT_TIMEOUT', `Extracting the zip archive made no progress for ${stallMinutes(UNZIP_STALL_MS)} and was stopped`, stderr.trim()));
      } else if (code === 0 || code === 1) {
        resolvePromise();
      } else {
        reject(containerError('CONTAINER_ZIP_INVALID', 'Failed to extract zip archive', stderr.trim() || `unzip exited ${code}`));
      }
    });
  });
}

/** A directory mount's config entry, or the error a zip upload to it gets. */
async function zipTargetMount(containerName, mountName) {
  const config = await loadContainerJson(containerName);
  const m = findMount(config, mountName);
  if (!m) {
    throw containerError('CONTAINER_MOUNT_NOT_FOUND', `No mount named "${mountName}"`);
  }
  if (m.type !== 'directory') {
    throw containerError('CONTAINER_MOUNT_TYPE_MISMATCH', `Mount "${mountName}" is not a directory mount`);
  }
  if (m.sourceId) {
    throw containerError(
      'CONTAINER_MOUNT_TYPE_MISMATCH',
      `Zip upload is only supported for Local directory mounts; "${mountName}" is sourced from a storage mount`,
    );
  }
  return m;
}

/** Fail fast before an upload is staged: the mount must take a zip. */
export async function assertMountTakesZip(containerName, mountName) {
  await zipTargetMount(containerName, mountName);
}

/**
 * Check a staged zip for `mountName` (the mount takes zips; no zip-slip path,
 * via `unzip -Z1`) and return its plan for `extractMountZip`. Quick; changes
 * nothing.
 */
export async function planMountZipExtract(containerName, mountName, zipPath) {
  await zipTargetMount(containerName, mountName);
  await assertZipPathsSafe(zipPath);
  return { containerName, mountName, zipPath };
}

/** Replace the directory mount's contents with the planned zip's (system `unzip`). The caller removes the zip. */
export async function extractMountZip({ containerName, mountName, zipPath }) {
  await mkdir(getContainerFilesDir(containerName), { recursive: true });
  const destDir = artifactPath(containerName, mountName);
  await rm(destDir, { recursive: true, force: true });
  await mkdir(destDir, { recursive: true });
  await extractZipWithUnzipCli(zipPath, resolve(destDir));
  return { ok: true };
}

/** Empty file (0 bytes) or empty directory. */
export async function initMountContent(containerName, mountName) {
  const config = await loadContainerJson(containerName);
  const m = findMount(config, mountName);
  if (!m) {
    throw containerError('CONTAINER_MOUNT_NOT_FOUND', `No mount named "${mountName}"`);
  }
  if (m.type === 'tmpfs') {
    throw containerError('CONTAINER_MOUNT_TYPE_MISMATCH', `Mount "${mountName}" is tmpfs and has no host backing store`);
  }
  const filesDir = getContainerFilesDir(containerName);
  await mkdir(filesDir, { recursive: true });
  const p = artifactPath(containerName, mountName);
  if (m.type === 'file') {
    const mode = mountFileWriteMode(m, undefined);
    if (mode != null) await chmodIfExists(p, mode);
    await writeFile(p, Buffer.alloc(0), mode != null ? { mode } : undefined);
  } else {
    await rm(p, { recursive: true, force: true });
    await mkdir(p, { recursive: true });
  }
  return { ok: true };
}

/**
 * The checks a mount's data delete (`'data'`) or a mount's removal
 * (`'remove'`) makes first, quick and without side effects:
 * CONTAINER_NOT_FOUND, CONTAINER_MOUNT_NOT_FOUND, and for data a tmpfs mount
 * (CONTAINER_MOUNT_TYPE_MISMATCH).
 */
export async function assertMountOperation(containerName, mountName, what) {
  const config = await loadContainerJson(containerName);
  const m = findMount(config, mountName);
  if (!m) {
    throw containerError('CONTAINER_MOUNT_NOT_FOUND', `No mount named "${mountName}"`);
  }
  if (what === 'data' && m.type === 'tmpfs') {
    throw containerError('CONTAINER_MOUNT_TYPE_MISMATCH', `Mount "${mountName}" is tmpfs and has no host backing store`);
  }
}

/** Remove backing file or directory; mount row stays in container.json until PATCH. */
export async function deleteMountData(containerName, mountName) {
  const config = await loadContainerJson(containerName);
  const m = findMount(config, mountName);
  if (!m) {
    throw containerError('CONTAINER_MOUNT_NOT_FOUND', `No mount named "${mountName}"`);
  }
  if (m.type === 'tmpfs') {
    throw containerError('CONTAINER_MOUNT_TYPE_MISMATCH', `Mount "${mountName}" is tmpfs and has no host backing store`);
  }
  const p = artifactPath(containerName, mountName);
  await rm(p, { recursive: true, force: true });
  return { ok: true };
}

/**
 * Delete on-disk artifact when a mount definition is removed from config. No-op for tmpfs.
 * The entry comes from the persisted config, not fresh input, so its name is re-checked
 * here: this is a recursive delete joined onto files/, and a name like `..` would
 * reach the container dir or above.
 */
export async function deleteMountBackingStore(containerName, mountEntry) {
  if (mountEntry?.type === 'tmpfs') return;
  if (validateMountSegmentName(mountEntry?.name) !== mountEntry?.name) {
    throw containerError('INVALID_CONTAINER_MOUNTS', `Refusing to delete backing store for invalid mount name "${mountEntry?.name}"`);
  }
  const p = join(getContainerFilesDir(containerName), mountEntry.name);
  await rm(p, { recursive: true, force: true });
}

/**
 * Delete the backing store of a mount that has already left `config.mounts` —
 * the explicit second step after `updateContainerConfig` reports it in
 * `removedMounts`. Replacing the mount list never deletes data by itself, so a
 * caller that only meant to rearrange mounts can't destroy any by accident.
 * Refuses while the name is still configured as a Local mount: a live mount's
 * data goes through `removeContainerMount` / `deleteMountData` instead. A name
 * now configured as Storage-sourced no longer uses files/<name>.
 */
export async function deleteRemovedMountData(containerName, mountName) {
  const config = await loadContainerJson(containerName);
  const configured = findMount(config, mountName);
  if (configured && !configured.sourceId) {
    throw containerError('CONFIG_ERROR', `Mount "${mountName}" is still configured — remove it from the mount list first`);
  }
  await deleteMountBackingStore(containerName, { name: mountName });
}

async function pathExists(p) {
  try {
    await lstat(p);
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Move a Local mount's backing store files/<fromName> → files/<toName>, so a
 * renamed mount keeps its data. Refuses when files/<toName> already exists:
 * rename(2) would silently replace an empty directory or overwrite a file left
 * there by an earlier mount. Returns false when files/<fromName> doesn't exist
 * (nothing to move — the caller creates the new artifact).
 */
export async function renameMountBackingStore(containerName, fromName, toName) {
  for (const n of [fromName, toName]) {
    if (validateMountSegmentName(n) !== n) {
      throw containerError('INVALID_CONTAINER_MOUNTS', `Invalid mount name "${n}"`);
    }
  }
  const filesDir = getContainerFilesDir(containerName);
  const to = join(filesDir, toName);
  if (await pathExists(to)) {
    throw containerError(
      'CONTAINER_MOUNT_DUPLICATE',
      `Cannot rename mount "${fromName}" to "${toName}": files/${toName} already exists on disk`,
      `${to} is left over from an earlier mount — move or remove it, or pick another name`,
    );
  }
  try {
    await rename(join(filesDir, fromName), to);
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Read mount backing file as UTF-8 text (for in-app editor). Rejects non-UTF-8 and oversize files.
 * A `secret` mount's content is write-only for every caller: refused with CONTAINER_MOUNT_SECRET.
 */
export async function getMountFileTextContent(containerName, mountName) {
  const config = await loadContainerJson(containerName);
  const m = findMount(config, mountName);
  if (!m) {
    throw containerError('CONTAINER_MOUNT_NOT_FOUND', `No mount named "${mountName}"`);
  }
  if (m.type !== 'file') {
    throw containerError('CONTAINER_MOUNT_TYPE_MISMATCH', `Mount "${mountName}" is not a file mount`);
  }
  if (m.secret === true) {
    throw mountSecretError(mountName);
  }
  const p = artifactPath(containerName, mountName);
  let st;
  try {
    st = await stat(p);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw containerError(
        'CONTAINER_MOUNT_SOURCE_MISSING',
        `No file on disk for mount "${mountName}"`,
      );
    }
    throw err;
  }
  if (!st.isFile()) {
    throw containerError(
      'CONTAINER_MOUNT_SOURCE_WRONG_TYPE',
      `Mount "${mountName}" must be backed by a file on the host`,
    );
  }
  if (st.size > MOUNT_FILE_CONTENT_MAX_BYTES) {
    throw containerError(
      'CONTAINER_MOUNT_FILE_TOO_LARGE',
      `Mount file exceeds ${MOUNT_FILE_CONTENT_MAX_BYTES} bytes`,
    );
  }
  const buf = await readFile(p);
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw containerError('CONTAINER_MOUNT_FILE_NOT_UTF8', 'File is not valid UTF-8 text');
  }
  return { content: buf.toString('utf8') };
}

/**
 * Replace mount backing file with UTF-8 text from the editor.
 * `options.mode` (e.g. 0o600 for an app-declared secret) is applied before the new
 * content is written — to an existing file by chmod, to a new one at creation — so
 * the content never sits on disk under a wider mode. A stored `secret: true` mount
 * always gets SECRET_MOUNT_FILE_MODE that way. Otherwise an existing file keeps its
 * mode and a new one gets the umask default.
 */
export async function putMountFileTextContent(containerName, mountName, content, { mode } = {}) {
  if (typeof content !== 'string') {
    throw containerError('INVALID_CONTAINER_MOUNTS', 'content must be a string');
  }
  const bytes = new TextEncoder().encode(content);
  if (bytes.length > MOUNT_FILE_CONTENT_MAX_BYTES) {
    throw containerError(
      'CONTAINER_MOUNT_FILE_TOO_LARGE',
      `Mount file exceeds ${MOUNT_FILE_CONTENT_MAX_BYTES} bytes`,
    );
  }
  const config = await loadContainerJson(containerName);
  const m = findMount(config, mountName);
  if (!m) {
    throw containerError('CONTAINER_MOUNT_NOT_FOUND', `No mount named "${mountName}"`);
  }
  if (m.type !== 'file') {
    throw containerError('CONTAINER_MOUNT_TYPE_MISMATCH', `Mount "${mountName}" is not a file mount`);
  }
  const filesDir = getContainerFilesDir(containerName);
  await mkdir(filesDir, { recursive: true });
  const dest = artifactPath(containerName, mountName);
  const fileMode = mountFileWriteMode(m, mode);
  if (fileMode != null) await chmodIfExists(dest, fileMode);
  await writeFile(dest, bytes, fileMode != null ? { mode: fileMode } : undefined);
  return { ok: true };
}

/**
 * Empty a file mount's backing file — what un-marking a secret mount does to its content,
 * so the flag can't be dropped to read a secret back (same contract as secret env vars).
 * The file is left in place (0 bytes, same inode) so the bind source keeps existing, and
 * goes back to the plain-file mode only once it is empty.
 */
export async function clearMountBackingFile(containerName, mountName) {
  if (validateMountSegmentName(mountName) !== mountName) {
    throw containerError('INVALID_CONTAINER_MOUNTS', `Invalid mount name "${mountName}"`);
  }
  await mkdir(getContainerFilesDir(containerName), { recursive: true });
  const p = artifactPath(containerName, mountName);
  await writeFile(p, Buffer.alloc(0));
  await chmod(p, plainMountFileMode());
}

/**
 * Tighten the backing file of every Local secret file mount in `mounts` to
 * SECRET_MOUNT_FILE_MODE — run after a config write that may have marked a mount
 * secret (its existing content was written under the plain mode). Missing files
 * are skipped; ensureMountArtifactIfMissing creates them at the secret mode.
 */
export async function tightenSecretMountFiles(containerName, mounts) {
  for (const m of mounts || []) {
    if (m?.type !== 'file' || m.secret !== true || m.sourceId) continue;
    if (validateMountSegmentName(m.name) !== m.name) continue;
    await chmodIfExists(artifactPath(containerName, m.name), SECRET_MOUNT_FILE_MODE);
  }
}

/**
 * Permission bits (`st.mode & 0o7777`) of a file mount's backing file, or null
 * when there is none on disk. Metadata only, like getMountFileSize.
 */
export async function getMountFileMode(containerName, mountName) {
  if (validateMountSegmentName(mountName) !== mountName) return null;
  try {
    const st = await lstat(artifactPath(containerName, mountName));
    return st.isFile() ? st.mode & 0o7777 : null;
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Set the permission bits of a file mount's backing file (e.g. tighten a secret
 * to 0o600). The container sees the change at once — its bind mount is the
 * same inode — so no restart is involved.
 */
export async function setMountFileMode(containerName, mountName, mode) {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) {
    throw containerError('INVALID_CONTAINER_MOUNTS', 'mode must be a permission-bits integer');
  }
  const config = await loadContainerJson(containerName);
  const m = findMount(config, mountName);
  if (!m) {
    throw containerError('CONTAINER_MOUNT_NOT_FOUND', `No mount named "${mountName}"`);
  }
  if (m.type !== 'file') {
    throw containerError('CONTAINER_MOUNT_TYPE_MISMATCH', `Mount "${mountName}" is not a file mount`);
  }
  const p = artifactPath(containerName, mountName);
  let st;
  try {
    st = await lstat(p);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw containerError('CONTAINER_MOUNT_SOURCE_MISSING', `No file on disk for mount "${mountName}"`);
    }
    throw err;
  }
  if (!st.isFile()) {
    throw containerError('CONTAINER_MOUNT_SOURCE_WRONG_TYPE', `Mount "${mountName}" must be backed by a file on the host`);
  }
  await chmod(p, mode);
  return { ok: true };
}

/**
 * Size in bytes of a file mount's backing file, or null when there is none on disk.
 * Metadata only — lets callers report whether a secret file is set without reading it.
 */
export async function getMountFileSize(containerName, mountName) {
  if (validateMountSegmentName(mountName) !== mountName) return null;
  try {
    const st = await stat(artifactPath(containerName, mountName));
    return st.isFile() ? st.size : null;
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}
