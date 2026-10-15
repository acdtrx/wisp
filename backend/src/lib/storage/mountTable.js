/**
 * The kernel mount table (`/proc/self/mounts`) as structured entries — the one
 * reader for every "what is mounted where" question in the backend.
 *
 * `/proc/self/mounts` rather than `/proc/self/mountinfo`: it is the table the
 * `wisp-mount` helper checks before unmounting, so the backend and the helper
 * agree on what "mounted" means, and no consumer needs mountinfo's extra fields
 * (mount ids, bind-mount roots, propagation).
 *
 * Format: one mount per line, single-space separated fields
 * `source mountPoint fsType options dump pass`. The kernel octal-escapes space,
 * tab, newline and backslash inside fields (`\040`, `\011`, `\012`, `\134`), so
 * splitting on raw newlines and spaces is safe once each field is decoded.
 * Entries keep kernel order, which is mount order: when several mounts are
 * stacked on one path, the last entry for it is the one visible there.
 */
import { readFileSync } from 'node:fs';

const MOUNT_TABLE_PATH = '/proc/self/mounts';

/**
 * @typedef {object} MountEntry
 * @property {string} source      device or source spec, e.g. "/dev/sdb1", "//nas/share", "tmpfs"
 * @property {string} mountPoint  canonical absolute path (no symlinks, no trailing slash except "/")
 * @property {string} fsType      e.g. "ext4", "cifs"
 */

/** Undo the kernel's `\ooo` escapes. A literal backslash is always emitted as
 *  `\134`, so every backslash in a field starts an escape. */
function decodeField(field) {
  return field.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}

/**
 * Parse mount table text (the `/proc/self/mounts` format).
 * @param {string} text
 * @returns {MountEntry[]} in kernel (mount) order, stacked mounts included
 */
export function parseMountTable(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    const fields = line.split(' ');
    if (fields.length < 3 || !fields[1]) continue;
    entries.push({
      source: decodeField(fields[0]),
      mountPoint: decodeField(fields[1]),
      fsType: decodeField(fields[2]),
    });
  }
  return entries;
}

/**
 * Current mount table of the backend's mount namespace.
 * @returns {MountEntry[]} empty when the table is unreadable (no procfs, e.g. macOS dev)
 */
export function readMountTable() {
  let text;
  try {
    text = readFileSync(MOUNT_TABLE_PATH, 'utf8');
  } catch {
    /* no procfs (macOS dev) — nothing is mounted as far as Wisp can tell */
    return [];
  }
  return parseMountTable(text);
}

/**
 * True when something is mounted exactly at `path`. A mount on a parent
 * directory does not count: `/mnt/wisp/share` is not mounted just because
 * `/mnt` is.
 * @param {string} path absolute path; trailing slashes ignored
 * @param {MountEntry[]} [table]
 */
export function isMountPoint(path, table = readMountTable()) {
  const want = path.replace(/\/+$/, '') || '/';
  return table.some((e) => e.mountPoint === want);
}
