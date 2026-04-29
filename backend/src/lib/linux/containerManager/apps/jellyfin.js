/**
 * Jellyfin app module.
 *
 * Wraps the official `jellyfin/jellyfin` image with three managed mounts
 * (config / cache / media) and an optional GPU passthrough toggle that wires
 * into the generic container `devices` field. The user still enables hardware
 * acceleration inside Jellyfin's admin UI — we only expose the device.
 */
import { containerError } from '../containerManagerConnection.js';
import { getRawMounts } from '../../../settings.js';
import { listHostGpus } from '../../host/hostGpus.js';

function getDefaultAppConfig({ containerName } = {}) {
  return {
    media: { sourceId: null, subPath: '' },
    gpuEnabled: false,
    publishedUrl: containerName ? `http://${containerName}.local:8096` : '',
  };
}

function validateAppConfig(appConfig) {
  if (!appConfig || typeof appConfig !== 'object' || Array.isArray(appConfig)) {
    throw containerError('INVALID_APP_CONFIG', 'appConfig must be an object');
  }

  const media = appConfig.media && typeof appConfig.media === 'object' && !Array.isArray(appConfig.media)
    ? appConfig.media
    : {};
  const sourceId = media.sourceId == null || media.sourceId === ''
    ? null
    : (typeof media.sourceId === 'string' ? media.sourceId.trim() : null);
  if (sourceId === null && media.sourceId !== null && media.sourceId !== undefined && media.sourceId !== '') {
    throw containerError('INVALID_APP_CONFIG', 'media.sourceId must be a string or null');
  }
  const rawSub = typeof media.subPath === 'string' ? media.subPath.trim() : '';
  if (rawSub.split('/').some((seg) => seg === '..')) {
    throw containerError('INVALID_APP_CONFIG', 'media.subPath must not contain ".." segments');
  }
  const subPath = rawSub.replace(/^\/+|\/+$/g, '');

  const gpuEnabled = appConfig.gpuEnabled === true;

  const publishedUrl = typeof appConfig.publishedUrl === 'string' ? appConfig.publishedUrl.trim() : '';

  return {
    media: { sourceId, subPath },
    gpuEnabled,
    publishedUrl,
  };
}

async function generateDerivedConfig(appConfig) {
  const mounts = [
    { type: 'directory', name: 'config', containerPath: '/config', readonly: false },
    { type: 'directory', name: 'cache', containerPath: '/cache', readonly: false },
  ];

  if (appConfig.media?.sourceId) {
    const storageMounts = await getRawMounts();
    if (!storageMounts.some((m) => m.id === appConfig.media.sourceId)) {
      throw containerError(
        'INVALID_APP_CONFIG',
        `media.sourceId "${appConfig.media.sourceId}" does not reference a configured storage mount`,
      );
    }
    mounts.push({
      type: 'directory',
      name: 'media',
      containerPath: '/media',
      readonly: false,
      sourceId: appConfig.media.sourceId,
      subPath: appConfig.media.subPath || '',
    });
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

function requiresRestartForChange(oldCfg, newCfg) {
  if (!oldCfg) return true;
  if (oldCfg.gpuEnabled !== newCfg.gpuEnabled) return true;
  const a = oldCfg.media || {};
  const b = newCfg.media || {};
  if ((a.sourceId || null) !== (b.sourceId || null)) return true;
  if ((a.subPath || '') !== (b.subPath || '')) return true;
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
