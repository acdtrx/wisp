/**
 * Writing a file mount's backing file in place: pure filesystem work, tested
 * on any platform. The file itself is kept (its inode), never renamed over: a
 * running task's bind mount holds that file, and a rename would leave it
 * reading the old one.
 */
import { constants } from 'node:fs';
import { lstat, open, unlink } from 'node:fs/promises';

import { containerError } from '../containerManagerShared.js';
import { createStallWatchdog, stallMinutes } from '../../storage/index.js';

/** A copy into a mount's file that moves no byte for this long is stopped (CODING-RULES §6). */
const COPY_STALL_MS = 60_000;

/**
 * Write `content` into the file at `dest`, in place: a Uint8Array, or
 * `{ fromPath }`, a whole staged upload to copy from. `mode`, when given, is
 * put on the file before any content lands in it (a secret mount's 0600, so
 * the new content never sits under a wider one); else an existing file keeps
 * its own and a new one is made at 0666 under the umask. The content is
 * written from the start and the file then cut to its length, so a reader
 * never meets it empty, and nothing of a longer old content is left. A
 * missing `dest` is made; a symbolic link at `dest` is removed and a file made
 * in its place, never followed out of the container's files. Answers the
 * file's size and modified time.
 */
export async function writeMountFileInPlace(dest, content, mode, { stallMs = COPY_STALL_MS } = {}) {
  const info = await lstat(dest).catch((err) => {
    if (err.code === 'ENOENT') return null; // missing: made by the open below
    throw err;
  });
  if (info?.isSymbolicLink()) await unlink(dest);
  // O_NOFOLLOW: a link put there since the check fails the open, never followed.
  const handle = await open(dest, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, mode ?? 0o666);
  try {
    if (mode != null) await handle.chmod(mode);
    const length = content instanceof Uint8Array
      ? (await handle.write(content, 0, content.length, 0)).bytesWritten
      : await copyInto(handle, content.fromPath, stallMs);
    await handle.truncate(length);
    const after = await handle.stat();
    return { size: after.size, modified: after.mtime.toISOString() };
  } finally {
    await handle.close();
  }
}

/**
 * Copy the file at `fromPath` into `handle` from its start; answers the bytes
 * copied. Each read and write is one step, raced against the bound: a step
 * that hangs (a disk that stops answering) ends the copy with the error, the
 * step itself left to the thread pool, which no signal stops.
 */
async function copyInto(handle, fromPath, stallMs) {
  let stalled;
  const watchdog = createStallWatchdog({ stallMs, onStall: () => stalled?.() });
  const stall = new Promise((_resolve, reject) => {
    stalled = () => reject(containerError(
      'CONTAINER_MOUNT_WRITE_STALLED',
      `Writing the upload into the mount's file made no progress for ${stallMinutes(stallMs)} and was stopped`,
    ));
  });
  stall.catch(() => { /* answered by the race below, when it fires */ });
  const source = await open(fromPath, 'r');
  const buffer = Buffer.alloc(1 << 20);
  let copied = 0;
  try {
    for (;;) {
      const { bytesRead } = await Promise.race([source.read(buffer, 0, buffer.length, copied), stall]);
      if (bytesRead === 0) return copied;
      await Promise.race([handle.write(buffer, 0, bytesRead, copied), stall]);
      copied += bytesRead;
      watchdog.poke();
    }
  } finally {
    watchdog.stop();
    await source.close();
  }
}
