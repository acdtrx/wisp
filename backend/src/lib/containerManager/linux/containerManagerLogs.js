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
const TAIL_READ_CHUNK_BYTES = 64 * 1024;
/** A line still without its newline past this size is delivered as it stands (bounds the live tail's buffer). */
const MAX_PARTIAL_LINE_BYTES = 64 * 1024;

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
 * Read backwards from the end of an open file in fixed chunks until the bytes
 * read hold more than `tailLines` newlines (or the start is reached) — enough
 * for the last `tailLines` newline-separated segments to be complete — so a
 * long-running container's multi-hundred-MB log costs a few chunk reads.
 * Chunks are joined before decoding, so a UTF-8 sequence split across a
 * chunk boundary decodes intact.
 */
async function readTailBytes(fh, size, tailLines) {
  const chunks = [];
  let pos = size;
  let newlines = 0;
  while (pos > 0 && newlines <= tailLines) {
    const len = Math.min(TAIL_READ_CHUNK_BYTES, pos);
    pos -= len;
    const chunk = Buffer.alloc(len);
    const { bytesRead } = await fh.read(chunk, 0, len, pos);
    const got = chunk.subarray(0, bytesRead);
    for (const byte of got) if (byte === 0x0a) newlines += 1;
    chunks.unshift(got);
  }
  return Buffer.concat(chunks);
}

/**
 * Read the last N lines from a specific run's log (all when `tailLines` is 0),
 * blank lines dropped. `totalSize` is the log's byte size.
 */
export async function getContainerRunLogs(name, runId, tailLines = HISTORY_TAIL_LINES) {
  const logPath = getRunLogPath(name, runId);
  let fh;
  try {
    fh = await open(logPath, 'r');
  } catch (err) {
    if (err.code === 'ENOENT') return { lines: [], totalSize: 0 };
    throw containerError('CONTAINERD_ERROR', `Failed to read run log for "${name}"`, err.message);
  }
  try {
    const { size } = await fh.stat();
    const buf = tailLines > 0 ? await readTailBytes(fh, size, tailLines) : await fh.readFile();
    const all = buf.toString('utf8').split('\n');
    const lines = (tailLines > 0 ? all.slice(-tailLines) : all).filter((l) => l.length > 0);
    return { lines, totalSize: size };
  } catch (err) {
    throw containerError('CONTAINERD_ERROR', `Failed to read run log for "${name}"`, err.message);
  } finally {
    await fh.close().catch(() => { /* read result already settled; nothing to report */ });
  }
}

/**
 * History for the live log view: the last `tailLines` complete lines of a
 * run (blank lines dropped) and the byte `offset` the live tail continues
 * from — just past the last newline. A trailing line still being written is
 * not part of the history; the tail delivers it once its newline lands (or
 * the run ends), so no line is shown twice or split.
 * @returns {Promise<{ lines: string[], offset: number }>}
 */
export async function readRunLogHistory(name, runId, tailLines = HISTORY_TAIL_LINES) {
  const logPath = getRunLogPath(name, runId);
  let fh;
  try {
    fh = await open(logPath, 'r');
  } catch (err) {
    if (err.code === 'ENOENT') return { lines: [], offset: 0 };
    throw containerError('CONTAINERD_ERROR', `Failed to read run log for "${name}"`, err.message);
  }
  try {
    const { size } = await fh.stat();
    const buf = await readTailBytes(fh, size, tailLines);
    const bufStart = size - buf.length;
    const lastNewline = buf.lastIndexOf(0x0a);
    if (lastNewline === -1) return { lines: [], offset: bufStart };
    const complete = buf.subarray(0, lastNewline).toString('utf8').split('\n');
    const lines = complete.slice(-tailLines).filter((l) => l.length > 0);
    return { lines, offset: bufStart + lastNewline + 1 };
  } catch (err) {
    throw containerError('CONTAINERD_ERROR', `Failed to read run log for "${name}"`, err.message);
  } finally {
    await fh.close().catch(() => { /* read result already settled; nothing to report */ });
  }
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
 * Stream lines appended to a run's log from byte `fromOffset` on — the
 * `offset` of the `readRunLogHistory` call the caller showed, so the history
 * and the tail meet exactly. Calls onLine(line) once per complete line, in
 * order (blank lines dropped). A trailing line without its newline is held
 * until the newline arrives, or until the run has ended (then delivered as it
 * stands); one past MAX_PARTIAL_LINE_BYTES is delivered as it stands.
 *
 * Reads are serialized: a change notification (fs.watch, the 2 s interval)
 * that arrives while a read is in flight marks a rerun instead of starting a
 * second reader over the same byte range. Returns a { stop() } handle; stop
 * closes the file handle once no read is in flight.
 */
export function streamContainerRunLogs(name, runId, fromOffset, onLine) {
  const logPath = getRunLogPath(name, runId);
  let offset = fromOffset;
  let partial = Buffer.alloc(0);
  let fh = null;
  let watcher = null;
  let stopped = false;
  let reading = false;
  let rerun = false;

  function emitLines(chunk) {
    let data = partial.length ? Buffer.concat([partial, chunk]) : chunk;
    let nl;
    while ((nl = data.indexOf(0x0a)) !== -1) {
      const line = data.subarray(0, nl).toString('utf8');
      data = data.subarray(nl + 1);
      if (line.length > 0) onLine(line);
    }
    partial = Buffer.from(data);
    if (partial.length > MAX_PARTIAL_LINE_BYTES) flushPartial();
  }

  function flushPartial() {
    if (partial.length === 0) return;
    const line = partial.toString('utf8');
    partial = Buffer.alloc(0);
    if (line.length > 0) onLine(line);
  }

  async function readToEnd() {
    if (!fh) {
      try {
        fh = await open(logPath, 'r');
      } catch {
        /* log file not created yet (or already pruned) — the next notification retries */
        return;
      }
    }
    const { size } = await fh.stat();
    if (size < offset) {
      /* truncated in place: start over from its new beginning */
      offset = 0;
      partial = Buffer.alloc(0);
    }
    while (!stopped && size > offset) {
      const buf = Buffer.alloc(size - offset);
      const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      emitLines(buf.subarray(0, bytesRead));
    }
  }

  async function readPass() {
    await readToEnd();
    if (stopped || partial.length === 0) return;
    const meta = await readRunMeta(name, runId);
    if (meta?.endedAt == null) return;
    /* The run ended after its last write: read once more now that the end is
     * known, then the held partial line is the run's last line. */
    await readToEnd();
    if (!stopped) flushPartial();
  }

  function closeHandle() {
    if (!fh) return;
    const handle = fh;
    fh = null;
    handle.close().catch(() => { /* closing a read-only handle; nothing to report */ });
  }

  function scheduleRead() {
    if (stopped) return;
    if (reading) {
      rerun = true;
      return;
    }
    reading = true;
    (async () => {
      do {
        rerun = false;
        try {
          await readPass();
        } catch {
          /* transient read failure — the next notification retries from the same offset */
        }
      } while (rerun && !stopped);
    })().finally(() => {
      reading = false;
      if (stopped) closeHandle();
    });
  }

  try {
    watcher = watch(logPath, scheduleRead);
    watcher.on('error', () => {
      /* the file went away (run pruned) — the interval keeps polling a missing file harmlessly */
      watcher?.close();
      watcher = null;
    });
  } catch {
    /* log file missing — the interval picks it up once it exists */
  }

  const interval = setInterval(scheduleRead, 2000);
  /* bytes appended between the history read and the watch setup */
  scheduleRead();

  return {
    stop() {
      stopped = true;
      clearInterval(interval);
      if (watcher) watcher.close();
      if (!reading) closeHandle();
    },
  };
}

/**
 * Create a read stream for a run's log (used for file download).
 */
export function createRunLogReadStream(name, runId) {
  return createReadStream(getRunLogPath(name, runId));
}
