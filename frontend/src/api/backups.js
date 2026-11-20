import { api } from './client.js';

/**
 * Start a backup job for a VM: answers { jobId, kind, title, subject } (follow with awaitJob).
 */
export function startBackup(vmName, options = {}) {
  const body = options.destinationIds?.length
    ? { destinationIds: options.destinationIds }
    : { destinationIds: ['local'] };
  return api(`/api/vms/${encodeURIComponent(vmName)}/backup`, { method: 'POST', body });
}

/** Every VM backup, on every configured destination. */
export function listBackups({ signal } = {}) {
  return api('/api/backups', { signal });
}

/**
 * Restore a backup as a new VM: starts a job and answers `{ jobId, kind, title, subject }`
 * (follow it with awaitJob).
 * @param {{ destinationId: string, vmName: string, timestamp: string }} target — typically a row from listBackups()
 */
export function restoreBackup(target, newVmName) {
  const { destinationId, vmName, timestamp } = target;
  return api('/api/backups/restore', { method: 'POST', body: { destinationId, vmName, timestamp, newVmName } });
}

/**
 * Delete a backup.
 * @param {{ destinationId: string, vmName: string, timestamp: string }} target
 */
export function deleteBackup(target) {
  const { destinationId, vmName, timestamp } = target;
  return api('/api/backups', { method: 'DELETE', body: { destinationId, vmName, timestamp } });
}

/* ── Container backups ──────────────────────────────────────────── */

/**
 * Start a container backup job: answers { jobId, kind, title, subject } (follow with awaitJob).
 */
export function startContainerBackup(name, options = {}) {
  const body = options.destinationIds?.length
    ? { destinationIds: options.destinationIds }
    : { destinationIds: ['local'] };
  return api(`/api/containers/${encodeURIComponent(name)}/backup`, { method: 'POST', body });
}

/** Every container backup, on every configured destination. */
export function listContainerBackups({ signal } = {}) {
  return api('/api/container-backups', { signal });
}

/**
 * Restore a container backup as a new container: a job, answers `{ jobId, kind, title, subject }`.
 * @param {{ destinationId: string, name: string, timestamp: string }} target
 */
export function restoreContainerBackup(target, newName) {
  const { destinationId, name, timestamp } = target;
  return api('/api/container-backups/restore', { method: 'POST', body: { destinationId, name, timestamp, newName } });
}

/**
 * Restore a backup over the live container it was taken from. Container must
 * be stopped. A job: answers { jobId, kind, title, subject } (follow with awaitJob).
 * @param {{ destinationId: string, name: string, timestamp: string }} target
 * @param {{ safetyBackup?: boolean }} [options] — back up current state first (default true)
 */
export function restoreContainerBackupInPlace(target, options = {}) {
  const { destinationId, name, timestamp } = target;
  const safetyBackup = options.safetyBackup !== false;
  return api('/api/container-backups/restore-in-place', { method: 'POST', body: { destinationId, name, timestamp, safetyBackup } });
}

/** @param {{ destinationId: string, name: string, timestamp: string }} target */
export function deleteContainerBackup(target) {
  const { destinationId, name, timestamp } = target;
  return api('/api/container-backups', { method: 'DELETE', body: { destinationId, name, timestamp } });
}
