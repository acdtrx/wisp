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

/** @param {{ destinationId: string, name: string, timestamp: string }} target */
export function restoreContainerBackup(target, newName) {
  const { destinationId, name, timestamp } = target;
  return api('/api/container-backups/restore', { method: 'POST', body: { destinationId, name, timestamp, newName } });
}

/** @param {{ destinationId: string, name: string, timestamp: string }} target */
export function deleteContainerBackup(target) {
  const { destinationId, name, timestamp } = target;
  return api('/api/container-backups', { method: 'DELETE', body: { destinationId, name, timestamp } });
}
