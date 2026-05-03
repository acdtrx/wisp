/**
 * Jellyfin app module.
 *
 * Wraps the official `jellyfin/jellyfin` image with managed `/config` + `/cache`
 * mounts, zero or more user-defined media libraries (each mounted at
 * `/media/<label>` from a Storage source) and an optional GPU passthrough
 * toggle that wires into the generic container `devices` field. The user still
 * enables hardware acceleration inside Jellyfin's admin UI — we only expose
 * the device.
 */
import { basename } from 'node:path';

import { createAppError as containerError } from '../routeErrors.js';
import { getRawMounts } from '../settings.js';
import { listHostGpus } from '../host/index.js';

/** Validate a path segment used as a mount name. Returns normalized name or null. */
function validateMountSegmentName(name) {
  if (!name || typeof name !== 'string') return null;
  const t = name.trim();
  if (t.includes('/') || t.includes('\\') || t.includes('..')) return null;
  if (t.startsWith('.')) return null;
  if (t !== basename(t)) return null;
  return t;
}

/** Validate a relative sub-path (no `..`, no leading `/`). Empty string allowed. */
function validateSubPath(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return '';
  if (trimmed.startsWith('/')) return null;
  const segments = trimmed.split('/').filter((s) => s.length > 0);
  for (const seg of segments) {
    if (seg === '..' || seg === '.') return null;
  }
  return segments.join('/');
}

const RESERVED_LIBRARY_LABELS = new Set(['config', 'cache']);

function getDefaultAppConfig({ containerName } = {}) {
  return {
    libraries: [],
    gpuEnabled: false,
    publishedUrl: containerName ? `http://${containerName}.local:8096` : '',
  };
}

function validateAppConfig(appConfig) {
  if (!appConfig || typeof appConfig !== 'object' || Array.isArray(appConfig)) {
    throw containerError('INVALID_APP_CONFIG', 'appConfig must be an object');
  }

  const rawLibs = Array.isArray(appConfig.libraries) ? appConfig.libraries : [];
  const labels = new Set();
  const libraries = [];
  for (const raw of rawLibs) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw containerError('INVALID_APP_CONFIG', 'Each library must be an object');
    }
    const label = validateMountSegmentName(raw.label);
    if (!label) {
      throw containerError('INVALID_APP_CONFIG', 'Library label must be a non-empty path segment (no slashes, no "..", no leading dot)');
    }
    if (RESERVED_LIBRARY_LABELS.has(label)) {
      throw containerError('INVALID_APP_CONFIG', `Library label "${label}" is reserved`);
    }
    if (labels.has(label)) {
      throw containerError('INVALID_APP_CONFIG', `Duplicate library label "${label}"`);
    }
    labels.add(label);

    if (typeof raw.sourceId !== 'string' || !raw.sourceId.trim()) {
      throw containerError('INVALID_APP_CONFIG', `Library "${label}" must have a sourceId`);
    }
    const sourceId = raw.sourceId.trim();
    const subPath = validateSubPath(raw.subPath);
    if (subPath === null) {
      throw containerError('INVALID_APP_CONFIG', `Library "${label}" subPath must be relative without ".." segments`);
    }

    libraries.push({ label, sourceId, subPath });
  }

  const gpuEnabled = appConfig.gpuEnabled === true;

  const publishedUrl = typeof appConfig.publishedUrl === 'string' ? appConfig.publishedUrl.trim() : '';

  return {
    libraries,
    gpuEnabled,
    publishedUrl,
  };
}

async function generateDerivedConfig(appConfig) {
  const mounts = [
    { type: 'directory', name: 'config', containerPath: '/config', readonly: false },
    { type: 'directory', name: 'cache', containerPath: '/cache', readonly: false },
  ];

  if (Array.isArray(appConfig.libraries) && appConfig.libraries.length) {
    const storageMounts = await getRawMounts();
    for (const lib of appConfig.libraries) {
      if (!storageMounts.some((m) => m.id === lib.sourceId)) {
        throw containerError(
          'INVALID_APP_CONFIG',
          `Library "${lib.label}" sourceId "${lib.sourceId}" does not reference a configured storage mount`,
        );
      }
      mounts.push({
        type: 'directory',
        name: lib.label,
        containerPath: `/media/${lib.label}`,
        readonly: false,
        sourceId: lib.sourceId,
        subPath: lib.subPath || '',
      });
    }
  }

  const env = {};
  if (appConfig.publishedUrl) {
    env.JELLYFIN_PublishedServerUrl = { value: appConfig.publishedUrl };
  }

  // GPU passthrough is delegated to the generic `devices` field. When enabled,
  // we auto-pick the first available host GPU (Intel or AMD render node). On
  // multi-GPU hosts users can eject to a generic container and edit Devices
  // directly — keeping the app-level UI to a single checkbox per the v1 scope.
  let devices = [];
  if (appConfig.gpuEnabled) {
    const gpus = await listHostGpus();
    if (!gpus.length) {
      throw containerError(
        'INVALID_APP_CONFIG',
        'GPU acceleration enabled but no supported (Intel/AMD) GPU is detected on the host',
      );
    }
    devices = [{ type: 'gpu', device: gpus[0].device }];
  }

  return { env, mounts, devices };
}

function maskSecrets(appConfig) {
  return appConfig;
}

function getReloadCommand() {
  return null;
}

function librariesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if ((x.label || '') !== (y.label || '')) return false;
    if ((x.sourceId || '') !== (y.sourceId || '')) return false;
    if ((x.subPath || '') !== (y.subPath || '')) return false;
  }
  return true;
}

function requiresRestartForChange(oldCfg, newCfg) {
  if (!oldCfg) return true;
  if (oldCfg.gpuEnabled !== newCfg.gpuEnabled) return true;
  const a = Array.isArray(oldCfg.libraries) ? oldCfg.libraries : [];
  const b = Array.isArray(newCfg.libraries) ? newCfg.libraries : [];
  if (!librariesEqual(a, b)) return true;
  if ((oldCfg.publishedUrl || '') !== (newCfg.publishedUrl || '')) return true;
  return false;
}

export const jellyfinAppModule = {
  getDefaultAppConfig,
  validateAppConfig,
  generateDerivedConfig,
  maskSecrets,
  getReloadCommand,
  requiresRestartForChange,
};
