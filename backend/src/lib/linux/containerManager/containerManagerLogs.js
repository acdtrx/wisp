/**
 * Per-run container log files.
 *
 * Layout under <containerDir>/runs/:
 *   <runId>.log   — stdout+stderr from containerd-shim-runc-v2 for one task run
 *   <runId>.json  — sidecar metadata: { runId, startedAt, endedAt, exitCode, imageDigest }
 *
 * `runId` is a filesystem-safe ISO timestamp (`2026-04-18T12-34-56-789Z`). The
 * most recent run is always the one with `endedAt === null` (if any), since
 * containers run tasks serially. Retention: the newest RUN_RETENTION runs are
 * kept; older pairs are pruned on every new-run allocation.
 */
import { readFile, writeFile, readdir, mkdir, stat, open, unlink } from 'node:fs/promises';
import { watch, createReadStream } from 'node:fs';

import { containerError } from './containerManagerConnection.js';
import {
  getContainerRunsDir, getRunLogPath, getRunMetaPath, RUN_ID_REGEX,
} from './containerPaths.js';

const RUN_RETENTION = 10;
const HISTORY_TAIL_LINES = 500;

/** Build the filesystem-safe runId for a given instant (default now). */
function makeRunId(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

async function readRunMeta(name, runId) {
  try {
    const raw = await readFile(getRunMetaPath(name, runId), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function writeRunMeta(name, runId, meta) {
  await writeFile(getRunMetaPath(name, runId), JSON.stringify(meta, null, 2), 'utf8');
}

async function listRunIds(name) {
  let entries;
  try {
    entries = await readdir(getContainerRunsDir(name));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const ids = new Set();
  for (const entry of entries) {
    if (entry.endsWith('.log')) {
      const id = entry.slice(0, -4);
      if (RUN_ID_REGEX.test(id)) ids.add(id);
    } else if (entry.endsWith('.json')) {
      const id = entry.slice(0, -5);
      if (RUN_ID_REGEX.test(id)) ids.add(id);
    }
  }
  return [...ids].sort(); // lexicographic == chronological for this format
}

/** Prune runs beyond RUN_RETENTION (oldest first). */
async function pruneOldRuns(name) {
  const all = await listRunIds(name);
  if (all.length <= RUN_RETENTION) return;
  const toDelete = all.slice(0, all.length - RUN_RETENTION);
  await Promise.all(toDelete.flatMap((id) => [
    unlink(getRunLogPath(name, id)).catch(() => {}),
    unlink(getRunMetaPath(name, id)).catch(() => {}),
  ]));
}

/**
 * List runs for a container. Newest first.
 * Returns: [{ runId, startedAt, endedAt, exitCode, imageDigest, logSizeBytes }]
 */
export async function listContainerRuns(name) {
  const ids = await listRunIds(name);
  const runs = [];
  for (const runId of ids) {
    const meta = await readRunMeta(name, runId);
    let logSizeBytes = 0;
    try {
      const info = await stat(getRunLogPath(name, runId));
      logSizeBytes = info.size;
    } catch { /* log may be missing */ }
    runs.push({
      runId,
      startedAt: meta?.startedAt ?? null,
      endedAt: meta?.endedAt ?? null,
      exitCode: typeof meta?.exitCode === 'number' ? meta.exitCode : null,
      imageDigest: meta?.imageDigest ?? null,
      logSizeBytes,
    });
  }
  runs.reverse();
  return runs;
}

/**
 * Resolve a runId: if provided, validate; otherwise return the newest run
 * (current if any task is running, else most recent completed). Returns null
 * when no runs exist.
 */
export async function resolveRunId(name, runId) {
  if (runId) {
    if (!RUN_ID_REGEX.test(runId)) {
      throw containerError('CONTAINER_RUN_NOT_FOUND', `Invalid runId "${runId}"`);
    }
    try {
      await stat(getRunLogPath(name, runId));
    } catch {
      throw containerError('CONTAINER_RUN_NOT_FOUND', `Run "${runId}" not found for "${name}"`);
    }
    return runId;
  }
  const ids = await listRunIds(name);
  return ids.length ? ids[ids.length - 1] : null;
}

/**
 * Return the currently-active runId (endedAt === null) if any.
 */
export async function findCurrentRunId(name) {
  const ids = await listRunIds(name);
  for (let i = ids.length - 1; i >= 0; i--) {
    const meta = await readRunMeta(name, ids[i]);
    if (meta && meta.endedAt == null) return ids[i];
  }
  return null;
}

/**
 * Read the last N lines from a specific run's log.
 */
export async function getContainerRunLogs(name, runId, tailLines = HISTORY_TAIL_LINES) {
  const logPath = getRunLogPath(name, runId);
  let buf;
  try {
    buf = await readFile(logPath);
  } catch (err) {
    if (err.code === 'ENOENT') return { lines: [], totalSize: 0 };
    throw containerError('CONTAINERD_ERROR', `Failed to read run log for "${name}"`, err.message);
  }
  const content = buf.toString('utf8');
  const all = content.split('\n');
  const lines = tailLines > 0
    ? all.slice(-tailLines).filter((l) => l.length > 0)
    : all.filter((l) => l.length > 0);
  return { lines, totalSize: buf.length };
}

/**
 * Allocate a new run: create runs/ if missing, write the initial sidecar (endedAt=null),
 * prune oldest beyond retention, and return { runId, logPath }.
 */
export async function createNewRun(name, { imageDigest = null } = {}) {
  const runsDir = getContainerRunsDir(name);
  await mkdir(runsDir, { recursive: true });

  const startedAt = new Date();
  const runId = makeRunId(startedAt);

  // Touch the log file so it exists when the shim opens it (file:// URI).
  const fh = await open(getRunLogPath(name, runId), 'a');
  await fh.close();

  await writeRunMeta(name, runId, {
    runId,
    startedAt: startedAt.toISOString(),
    endedAt: null,
    exitCode: null,
    imageDigest: imageDigest || null,
  });

  await pruneOldRuns(name);

  return { runId, logPath: getRunLogPath(name, runId) };
}

/**
 * Mark a run finished: set endedAt + exitCode. No-op if runId is missing or already finalized.
 */
export async function finalizeRun(name, runId, { exitCode = null } = {}) {
  if (!runId) return;
  const meta = await readRunMeta(name, runId);
  if (!meta) return;
  if (meta.endedAt) return; // already finalized
  const updated = {
    ...meta,
    endedAt: new Date().toISOString(),
    exitCode: typeof exitCode === 'number' ? exitCode : null,
  };
  await writeRunMeta(name, runId, updated);
}

/**
 * Stream new lines appended to a specific run's log.
 * Returns a { stop() } handle. Calls onLine(line) for each new line.
 * Finalized runs (endedAt set) still tail safely — no new lines will arrive.
 */
export function streamContainerRunLogs(name, runId, onLine) {
  const logPath = getRunLogPath(name, runId);
  let offset = 0;
  let fh = null;
  let watcher = null;
  let stopped = false;

  async function readNew() {
    if (stopped) return;
    try {
      if (!fh) {
        fh = await open(logPath, 'r');
        const info = await stat(logPath);
        offset = info.size;
      }

      const info = await stat(logPath);
      if (info.size < offset) {
        offset = info.size;
        if (fh) {
          await fh.close().catch(() => {});
          fh = null;
        }
        return;
      }
      if (info.size <= offset) return;

      const buf = Buffer.alloc(info.size - offset);
      await fh.read(buf, 0, buf.length, offset);
      offset = info.size;

      const text = buf.toString('utf8');
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.length > 0) onLine(line);
      }
    } catch {
      // File may not exist yet
    }
  }

  try {
    watcher = watch(logPath, () => readNew());
  } catch {
    // Log file missing — readNew will catch up when the watcher is polled
  }

  const interval = setInterval(readNew, 2000);

  return {
    stop() {
      stopped = true;
      clearInterval(interval);
      if (watcher) watcher.close();
      if (fh) fh.close().catch(() => {});
    },
  };
}

/**
 * Create a read stream for a run's log (used for file download).
 */
export function createRunLogReadStream(name, runId) {
  return createReadStream(getRunLogPath(name, runId));
}
