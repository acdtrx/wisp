import { api } from './client.js';

export function getUpdateStatus({ signal } = {}) {
  return api('/api/updates/status', { signal });
}

/** Answers 204 (or the check's error): the status follows on the `wisp-update` cue. */
export function checkForWispUpdate() {
  return api('/api/updates/check', { method: 'POST' });
}

/**
 * Start the install pipeline as a job: answers `{ jobId, kind, title, subject }`.
 * force=true bypasses the active-jobs guard (UI confirms with the user first).
 */
export function installWispUpdate({ force = false } = {}) {
  const qs = force ? '?force=1' : '';
  return api(`/api/updates/install${qs}`, { method: 'POST' });
}
