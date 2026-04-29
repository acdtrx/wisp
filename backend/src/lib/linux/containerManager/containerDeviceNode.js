/**
 * Helpers for emitting host character devices into a container's OCI spec.
 *
 * - `statDeviceNode(path)` reads major/minor from a chardev (or throws).
 * - `getRenderGid()` resolves the host's `render` group GID (falls back to
 *   `video` when distros that lack `render` are encountered). Resolved each
 *   call — the GID number varies between distros and we never cache it.
 */
import { stat } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';

import { containerError } from './containerManagerConnection.js';

/**
 * @param {string} path absolute path to a host character device
 * @returns {Promise<{ major: number, minor: number }>}
 */
export async function statDeviceNode(path) {
  let st;
  try {
    st = await stat(path);
  } catch (err) {
    throw containerError(
      'CONTAINER_DEVICE_MISSING',
      `Host device "${path}" not found`,
      err?.message,
    );
  }
  if (!st.isCharacterDevice()) {
    throw containerError(
      'CONTAINER_DEVICE_MISSING',
      `Host path "${path}" is not a character device`,
    );
  }
  // glibc `dev_t` encoding (matches kernel MAJOR/MINOR macros):
  //   major = (dev >> 8) & 0xfff
  //   minor = (dev & 0xff) | ((dev >> 12) & ~0xff)
  // Equivalent to the simple legacy `dev / 256, dev % 256` formula for any
  // device that fits in 24 bits, which covers all standard chardevs incl. DRM.
  const rdev = st.rdev;
  const major = (rdev >>> 8) & 0xfff;
  const minor = (rdev & 0xff) | ((rdev >>> 12) & ~0xff);
  return { major, minor };
}

/**
 * Resolve the host major/minor for every device entry in `config.devices`,
 * plus the render GID we'll add to the in-container process. Throws
 * `CONTAINER_DEVICE_MISSING` if any configured device is absent or not a
 * chardev — this is the pre-start readiness check (symmetric to
 * `assertBindSourcesReady` for Storage mounts).
 *
 * @param {{ devices?: Array<{ type: string, device: string }> }} config
 * @returns {Promise<{
 *   deviceSpecs: Array<{ type: 'gpu', path: string, major: number, minor: number }>,
 *   renderGid: number | null,
 * }>}
 */
export async function resolveDeviceSpecs(config) {
  const list = Array.isArray(config?.devices) ? config.devices : [];
  if (!list.length) return { deviceSpecs: [], renderGid: null };

  const deviceSpecs = [];
  for (const d of list) {
    if (d?.type === 'gpu' && typeof d.device === 'string') {
      const { major, minor } = await statDeviceNode(d.device);
      deviceSpecs.push({ type: 'gpu', path: d.device, major, minor });
    }
  }

  const renderGid = deviceSpecs.length ? await getRenderGid() : null;
  return { deviceSpecs, renderGid };
}

/**
 * Look up the host group GID matching `render` (preferred) or `video`. Returns
 * null when neither group exists. Reads `/etc/group` directly — Node's `os`
 * has no group lookup API.
 */
export async function getRenderGid() {
  let text;
  try {
    text = await readFile('/etc/group', 'utf8');
  } catch {
    return null;
  }
  const map = new Map();
  for (const line of text.split('\n')) {
    if (!line) continue;
    const parts = line.split(':');
    if (parts.length < 3) continue;
    const gid = Number(parts[2]);
    if (!Number.isInteger(gid)) continue;
    map.set(parts[0], gid);
  }
  if (map.has('render')) return map.get('render');
  if (map.has('video')) return map.get('video');
  return null;
}
