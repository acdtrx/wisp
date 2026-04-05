/**
 * Container log management: read and stream container.log files.
 */
import { join } from 'node:path';
import { readFile, stat, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { watch } from 'node:fs';

import { containerError } from './containerManagerConnection.js';
import { getContainerDir } from './containerPaths.js';

/**
 * Read the last N lines from a container's log file.
 */
export async function getContainerLogs(name, tailLines = 200) {
  const logPath = join(getContainerDir(name), 'container.log');

  let content;
  try {
    content = await readFile(logPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { lines: [], totalSize: 0 };
    throw containerError('CONTAINERD_ERROR', `Failed to read logs for "${name}"`, err.message);
  }

  const allLines = content.split('\n');
  const lines = tailLines > 0
    ? allLines.slice(-tailLines).filter((l) => l.length > 0)
    : allLines.filter((l) => l.length > 0);

  let totalSize = 0;
  try {
    const info = await stat(logPath);
    totalSize = info.size;
  } catch { /* ignore */ }

  return { lines, totalSize };
}

/**
 * Stream new log lines as they are appended.
 * Returns a { stop() } handle. Calls onLine(line) for each new line.
 */
export function streamContainerLogs(name, onLine) {
  const logPath = join(getContainerDir(name), 'container.log');
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
    // File may not exist yet — will catch up when it does
  }

  // Also poll periodically in case fs.watch misses events
  const interval = setInterval(readNew, 2000);

  return {
    stop() {
      stopped = true;
      clearInterval(interval);
      if (watcher) watcher.close();
      /* Best-effort close; ignore if handle already closed */
      if (fh) fh.close().catch(() => {});
    },
  };
}
