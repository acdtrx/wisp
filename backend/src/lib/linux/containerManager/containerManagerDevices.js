/**
 * Validation + helpers for `container.json -> devices[]`.
 *
 * v1 only supports `type: "gpu"` (Intel/AMD render nodes). The array shape is
 * deliberately generic — we expect to add other host chardev types later — but
 * the current validator caps it at one entry and a single allowed type.
 *
 * Unlike VM PCI passthrough (VFIO), exposing a device to a container does not
 * detach it from the host kernel. The host driver still owns the device; we
 * just make the existing chardev visible inside the container's mount + cgroup
 * namespaces. See docs/spec/CONTAINERS.md → Devices entry.
 */
import { containerError } from './containerManagerConnection.js';

const MAX_DEVICES = 1;

/** Strictly the DRM render node — never `card<N>`, which exposes mode-setting. */
const RENDER_NODE_RE = /^\/dev\/dri\/renderD\d+$/;

/**
 * @param {unknown} devices
 * @returns {Array<{ type: 'gpu', device: string }>}
 */
export function validateAndNormalizeDevices(devices) {
  if (devices == null) return [];
  if (!Array.isArray(devices)) {
    throw containerError('INVALID_CONTAINER_DEVICES', 'devices must be an array');
  }
  if (devices.length > MAX_DEVICES) {
    throw containerError(
      'INVALID_CONTAINER_DEVICES',
      `devices is capped at ${MAX_DEVICES} entry in v1`,
    );
  }
  const out = [];
  const seenPaths = new Set();
  for (const raw of devices) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw containerError('INVALID_CONTAINER_DEVICES', 'Each device must be an object');
    }
    const allowedKeys = new Set(['type', 'device']);
    for (const key of Object.keys(raw)) {
      if (!allowedKeys.has(key)) {
        throw containerError(
          'INVALID_CONTAINER_DEVICES',
          `Unknown device field "${key}"`,
        );
      }
    }
    if (raw.type !== 'gpu') {
      throw containerError(
        'INVALID_CONTAINER_DEVICES',
        'device.type must be "gpu" (only supported type in v1)',
      );
    }
    const device = typeof raw.device === 'string' ? raw.device.trim() : '';
    if (!RENDER_NODE_RE.test(device)) {
      throw containerError(
        'INVALID_CONTAINER_DEVICES',
        'device must match /dev/dri/renderD<N> (DRM render node)',
      );
    }
    if (seenPaths.has(device)) {
      throw containerError(
        'INVALID_CONTAINER_DEVICES',
        `Duplicate device path "${device}"`,
      );
    }
    seenPaths.add(device);
    out.push({ type: 'gpu', device });
  }
  return out;
}

/**
 * True if the container's devices list contains a GPU passthrough entry.
 * Used by the OCI spec builder and the pre-start readiness check.
 * @param {{ devices?: unknown }} config
 */
export function hasGpuDevice(config) {
  if (!Array.isArray(config?.devices)) return false;
  return config.devices.some((d) => d?.type === 'gpu' && typeof d.device === 'string');
}
