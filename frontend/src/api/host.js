import { api } from './client.js';

export function getHostInfo({ signal } = {}) {
  return api('/api/host', { signal });
}

export function getHostHardware({ signal } = {}) {
  return api('/api/host/hardware', { signal });
}

export function getHostGpus({ signal } = {}) {
  return api('/api/host/gpus', { signal });
}

/** The check and the upgrade are jobs: they answer `{ jobId, kind, title, subject }` (follow with awaitJob). A check
 *  started while one runs answers the running one. */
export function checkForUpdates() {
  return api('/api/host/updates/check', { method: 'POST' });
}

export function performUpgrade() {
  return api('/api/host/updates/upgrade', { method: 'POST' });
}

/** What the last check found: `{ packages, downloadBytes, checkedAt }`, `checkedAt` null before any check. */
export function listUpgradablePackages({ signal } = {}) {
  return api('/api/host/updates/packages', { signal });
}

export function listManagedNetworkBridges({ signal } = {}) {
  return api('/api/host/network-bridges', { signal });
}

/** Bridge create and delete are jobs: they answer `{ jobId, kind, title, subject }`. */
export function createManagedNetworkBridge(baseBridge, vlanId) {
  return api('/api/host/network-bridges', {
    method: 'POST',
    body: { baseBridge, vlanId },
  });
}

export function deleteManagedNetworkBridge(name) {
  return api(`/api/host/network-bridges/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
}

export function hostShutdown() {
  return api('/api/host/power/shutdown', { method: 'POST' });
}

export function hostReboot() {
  return api('/api/host/power/restart', { method: 'POST' });
}
