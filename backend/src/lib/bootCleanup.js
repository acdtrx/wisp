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
import { readdir, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ATOMIC_TMP_SUFFIX_RE } from './atomicJson.js';
import { CONFIG_PATH } from './config.js';
import { getSettings } from './settings.js';

async function sweepDir(dir, log, { keep = new Set() } = {}) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
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

  let containersPath;
  try {
    const settings = await getSettings();
    containersPath = settings.containersPath;
  } catch {
    return;
  }
  if (!containersPath) return;

  let entries;
  try {
    entries = await readdir(containersPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const containerDir = join(containersPath, entry.name);
    await sweepDir(containerDir, log);
    // files/ holds the mounts' data under their names: those are never swept.
    let mountNames = new Set();
    try {
      const config = JSON.parse(await readFile(join(containerDir, 'container.json'), 'utf8'));
      mountNames = new Set((config.mounts || []).map((m) => m.name));
    } catch {
      continue; // no readable config: leave files/ alone
    }
    await sweepDir(join(containerDir, 'files'), log, { keep: mountNames });
  }
}
