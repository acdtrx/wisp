/**
 * macOS dev stub: no containerd.
 */
import { createAppError } from '../../routeErrors.js';
import { setContainerManagerConfig } from '../../linux/containerManager/containerPaths.js';

export function configure(cfg) {
  setContainerManagerConfig(cfg);
}

export {
  getContainersPath,
  getContainerDir,
  getContainerFilesDir,
  ensureContainersDir,
} from '../../linux/containerManager/containerPaths.js';

export { buildOCISpec } from '../../linux/containerManager/containerManagerSpec.js';

export const IS_DARWIN = true;

export function containerError(code, message, raw) {
  return createAppError(code, message, raw);
}

export const containerState = {
  clients: null,
  connected: false,
  containerStartTimes: new Map(),
  logger: null,
};

export async function connect(opts = {}) {
  if (opts.logger) containerState.logger = opts.logger;
  containerState.logger?.warn('macOS detected — running without containerd (dev mode)');
}

export function disconnect() {
  containerState.clients = null;
  containerState.connected = false;
  containerState.containerStartTimes.clear();
  containerState.logger = null;
}

function noContainerd() {
  return containerError('NO_CONTAINERD', 'Not connected to containerd');
}

export function getClient() {
  throw noContainerd();
}

export function callUnary() {
  return Promise.reject(noContainerd());
}

export function callStream() {
  throw noContainerd();
}

export function packAny(typeUrl, obj) {
  return {
    typeUrl,
    type_url: typeUrl,
    value: Buffer.from(JSON.stringify(obj)),
  };
}

export function unpackAny(any) {
  if (!any || !any.value) return null;
  const buf = any.value;
  if (!buf || buf.length === 0) return null;
  try {
    return JSON.parse(Buffer.isBuffer(buf) ? buf.toString('utf8') : buf);
  } catch {
    /* value is not JSON — expected for some Any payloads */
    return null;
  }
}

export async function listContainers() {
  return [];
}

export function subscribeContainerListChange() {
  return () => {};
}

export function notifyContainerConfigWrite() {
  /* no-op on darwin (no containerd) */
}

export async function getRunningContainerCount() {
  return 0;
}

export async function findContainersUsingStorageMount() {
  return [];
}

export async function discoverIpv4InNetnsOnce() {
  return null;
}

export async function writeContainerConfig() {
  throw containerError('NO_CONTAINERD', 'Containerd is not available on darwin');
}

export async function getContainerConfig(name) {
  throw containerError('CONTAINER_NOT_FOUND', `Container "${name}" not found`);
}

export async function startContainer() {
  throw noContainerd();
}

export async function startAutostartContainersAtBackendBoot() {
  /* macOS dev stub — no containerd */
}

export async function stopContainer() {
  throw noContainerd();
}

export async function killContainer() {
  throw noContainerd();
}

export async function restartContainer() {
  throw noContainerd();
}

export async function getTaskState() {
  throw noContainerd();
}

export async function createContainer() {
  throw noContainerd();
}

export async function deleteContainer() {
  throw noContainerd();
}

export async function renameContainer() {
  throw noContainerd();
}

export async function createContainerBackup() {
  throw noContainerd();
}

export async function listContainerBackups() {
  return [];
}

export async function restoreContainerBackup() {
  throw noContainerd();
}

export async function deleteContainerBackup() {
  throw noContainerd();
}

export async function pullImage() {
  throw noContainerd();
}

export async function listContainerImages() {
  return [];
}

export async function deleteContainerImage() {
  throw noContainerd();
}

export async function getImageDigest() {
  return null;
}

export async function findContainersUsingImage() {
  return [];
}

export async function checkAllImagesForUpdates() {
  return { checked: 0, updated: 0, flaggedContainers: 0, lastCheckedAt: new Date().toISOString() };
}

export async function checkSingleImageForUpdates() {
  throw noContainerd();
}

export function getImageUpdateStatus() {
  return { lastCheckedAt: null, imagesChecked: 0, imagesUpdated: 0 };
}

export function startImageUpdateChecker() {}

export function stopImageUpdateChecker() {}

export async function startExistingContainer() {
  throw noContainerd();
}

export async function updateContainerConfig() {
  throw noContainerd();
}

export async function addContainerMount() {
  throw noContainerd();
}

export async function updateContainerMount() {
  throw noContainerd();
}

export async function removeContainerMount() {
  throw noContainerd();
}

export async function addContainerService() {
  throw noContainerd();
}

export async function updateContainerService() {
  throw noContainerd();
}

export async function removeContainerService() {
  throw noContainerd();
}

export async function getContainerStats() {
  throw noContainerd();
}

export async function listContainerRuns() {
  throw noContainerd();
}

export async function getContainerRunLogs() {
  throw noContainerd();
}

export function streamContainerRunLogs() {
  throw noContainerd();
}

export async function resolveRunId() {
  throw noContainerd();
}

export function createRunLogReadStream() {
  throw noContainerd();
}

export async function uploadMountFileStream() {
  throw noContainerd();
}

export async function uploadMountZipStream() {
  throw noContainerd();
}

export async function initMountContent() {
  throw noContainerd();
}

export async function deleteMountData() {
  throw noContainerd();
}

export const MOUNT_FILE_CONTENT_MAX_BYTES = 512 * 1024;

export async function getMountFileTextContent() {
  throw noContainerd();
}

export async function putMountFileTextContent() {
  throw noContainerd();
}

export async function setupNetwork() {
  throw noContainerd();
}

export async function teardownNetwork() {
  throw noContainerd();
}

export async function execInContainer() {
  throw noContainerd();
}

export async function execCommandInContainer() {
  throw noContainerd();
}

export async function resizeExec() {
  throw noContainerd();
}
