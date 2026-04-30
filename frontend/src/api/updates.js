import { api } from './client.js';

export function getUpdateStatus() {
  return api('/api/updates/status');
}

export function checkForWispUpdate() {
  return api('/api/updates/check', { method: 'POST' });
}

/**
 * Start the install pipeline. force=true bypasses the active-jobs guard
 * (UI confirms with the user first).
 */
export function installWispUpdate({ force = false } = {}) {
  const qs = force ? '?force=1' : '';
  return api(`/api/updates/install${qs}`, { method: 'POST' });
}
