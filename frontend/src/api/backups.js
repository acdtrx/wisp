import { api } from './client.js';

/**
 * Start a backup job for a VM. Returns { jobId }; progress stream is GET /api/vms/backup-progress/:jobId (subscribed via background jobs).
 */
export function startBackup(vmName, options = {}) {
  const body = options.destinationIds?.length
    ? { destinationIds: options.destinationIds }
    : { destinationIds: ['local'] };
  return api(`/api/vms/${encodeURIComponent(vmName)}/backup`, { method: 'POST', body });
}

/**
 * List backups from configured destinations. Optional vmName filter.
 */
export function listBackups(vmName = null) {
  const q = vmName != null && vmName !== '' ? `?vmName=${encodeURIComponent(vmName)}` : '';
  return api(`/api/backups${q}`);
}

/**
 * Restore a backup as a new VM.
 */
export function restoreBackup(backupPath, newVmName) {
  return api('/api/backups/restore', { method: 'POST', body: { backupPath, newVmName } });
}

/**
 * Delete a backup. Path must be under a configured destination.
 */
export function deleteBackup(backupPath) {
  return api('/api/backups', { method: 'DELETE', body: { backupPath } });
}

/* ── Container backups ──────────────────────────────────────────── */

/**
 * Start a container backup job. Returns { jobId, title }; subscribe via JOB_KIND.CONTAINER_BACKUP.
 */
export function startContainerBackup(name, options = {}) {
  const body = options.destinationIds?.length
    ? { destinationIds: options.destinationIds }
    : { destinationIds: ['local'] };
  return api(`/api/containers/${encodeURIComponent(name)}/backup`, { method: 'POST', body });
}

export function listContainerBackups(containerName = null) {
  const q = containerName != null && containerName !== '' ? `?containerName=${encodeURIComponent(containerName)}` : '';
  return api(`/api/container-backups${q}`);
}

export function restoreContainerBackup(backupPath, newName) {
  return api('/api/container-backups/restore', { method: 'POST', body: { backupPath, newName } });
}

export function deleteContainerBackup(backupPath) {
  return api('/api/container-backups', { method: 'DELETE', body: { backupPath } });
}
