/**
 * Boot-time cleanup of atomic-write temp files.
 *
 * If the backend is killed between `writeFile(tmp)` and `rename(tmp, final)` —
 * crash, ENOSPC, OOM kill — the staged file is left behind. The destination
 * is intact (rename never happened), but the orphaned `*.tmp.<pid>.<ts>.<rand>`
 * file would otherwise sit on disk forever.
 *
 * Conservative by design: only removes regular files matching the suffix
 * pattern produced by writeJsonAtomic (and by a file-mount upload's temp file
 * in a container's files/), never a name a mount is configured under. Never
 * touches user data.
 */
import { readdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ATOMIC_TMP_SUFFIX_RE } from './base/index.js';
import { CONFIG_PATH } from './config.js';
import { getSettings } from './settings.js';
import { readContainerConfig } from './containerManager/index.js';

async function sweepDir(dir, log, { keep = new Set() } = {}) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code !== 'ENOENT') log?.warn?.({ err, dir }, 'Could not read a directory to remove orphan temp files');
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    const f = entry.name;
    if (!entry.isFile() || keep.has(f) || !ATOMIC_TMP_SUFFIX_RE.test(f)) continue;
    try {
      await unlink(join(dir, f));
      removed += 1;
      log?.warn?.({ file: join(dir, f) }, 'Removed orphan atomic-write temp file');
    } catch {
      /* ignore — file may already be gone */
    }
  }
  return removed;
}

export async function cleanPartialJsonArtifacts(log) {
  const settingsDir = dirname(CONFIG_PATH);
  await sweepDir(settingsDir, log);

  let settings;
  try {
    settings = await getSettings();
  } catch (err) {
    log?.warn?.({ err }, 'Could not read the settings: the VM and container directories keep their orphan temp files');
    return;
  }

  // Per-VM directories hold cloud-init.json, written atomically.
  if (settings.vmsPath) {
    let vmEntries = [];
    try {
      vmEntries = await readdir(settings.vmsPath, { withFileTypes: true });
    } catch {
      /* no VM storage yet: nothing to sweep */
    }
    for (const entry of vmEntries) {
      if (entry.isDirectory()) await sweepDir(join(settings.vmsPath, entry.name), log);
    }
  }

  const { containersPath } = settings;
  if (!containersPath) return;

  let entries;
  try {
    entries = await readdir(containersPath, { withFileTypes: true });
  } catch (err) {
    if (err.code !== 'ENOENT') log?.warn?.({ err, dir: containersPath }, 'Could not read the containers directory to remove orphan temp files');
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const containerDir = join(containersPath, entry.name);
    await sweepDir(containerDir, log);
    // files/ holds the mounts' data under their names: those are never swept.
    let mountNames = new Set();
    try {
      const config = await readContainerConfig(entry.name);
      mountNames = new Set((config.mounts || []).map((m) => m.name));
    } catch (err) {
      // No container here (a staging or session directory): nothing to keep apart.
      // A config that cannot be read: leave files/ alone, and say so.
      if (err.code !== 'CONTAINER_NOT_FOUND') {
        log?.warn?.({ err: err.message, container: entry.name }, '[bootCleanup] a container configuration could not be read: its files/ was not swept');
      }
      continue;
    }
    await sweepDir(join(containerDir, 'files'), log, { keep: mountNames });
  }
}
