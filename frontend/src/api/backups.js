import { api } from './client.js';

/**
 * Start a backup job for a VM. Returns { jobId }; progress stream is GET /api/vms/backup-progress/:jobId (subscribed via background jobs).
 */
export function startBackup(vmName, options = {}) {
  const body = {};
  if (options.destinationIds?.length) body.destinationIds = options.destinationIds;
  if (options.destinationPaths?.length) body.destinationPaths = options.destinationPaths;
  return api(`/api/vms/${encodeURIComponent(vmName)}/backup`, { method: 'POST', body: Object.keys(body).length ? body : { destinationIds: ['local'] } });
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
