import { api } from './client.js';

export function getHostInfo() {
  return api('/api/host');
}

export function getHostHardware() {
  return api('/api/host/hardware');
}

export function getHostGpus() {
  return api('/api/host/gpus');
}

/** The check, a refresh and the upgrade are jobs: they answer `{ jobId, title }` (follow with awaitJob). */
export function checkForUpdates() {
  return api('/api/host/updates/check', { method: 'POST' });
}

export function performUpgrade() {
  return api('/api/host/updates/upgrade', { method: 'POST' });
}

/** The cached list; with `refresh`, or no cache yet, the check job's `{ jobId, title }` instead. */
export function listUpgradablePackages({ refresh = false } = {}) {
  return api(`/api/host/updates/packages${refresh ? '?refresh=1' : ''}`);
}

export function listManagedNetworkBridges() {
  return api('/api/host/network-bridges');
}

/** Bridge create and delete are jobs: they answer `{ jobId, title }`. */
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
