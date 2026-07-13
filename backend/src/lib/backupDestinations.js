/**
 * Backup destination resolution shared by the VM/container backup routes and
 * the container backup scheduler. Turns client-facing destination ids
 * (`'local'` or the configured `backupMountId`) into absolute roots,
 * auto-mounting an unmounted SMB share on the way.
 */
import { getMountStatus, mountSMB } from './storage/index.js';
import { createAppError } from './routeErrors.js';

/**
 * Resolve destination ids to backup roots.
 *
 * @param {Awaited<ReturnType<import('./settings.js').getSettings>>} settings
 * @param {Array<object>} rawMounts - from getRawMounts() (carries SMB credentials)
 * @param {string[]} destinationIds - `'local'` and/or the configured backupMountId
 * @returns {Promise<Array<{ id: string, path: string, label: string }>>}
 * @throws BACKUP_DEST_UNKNOWN (422) - id is neither 'local' nor the configured backup mount
 * @throws BACKUP_MOUNT_FAILED (503) - SMB share could not be mounted
 * @throws BACKUP_DEST_NONE (422) - nothing resolved to a usable root
 */
export async function resolveBackupDestinations(settings, rawMounts, destinationIds) {
  const ids = Array.isArray(destinationIds) && destinationIds.length > 0 ? destinationIds : ['local'];
  const backupMountId = settings.backupMountId;
  const destinations = [];

  for (const id of ids) {
    if (id === 'local') {
      if (settings.backupLocalPath) {
        destinations.push({ id: 'local', path: settings.backupLocalPath, label: 'Local' });
      }
    } else if (backupMountId && id === backupMountId) {
      const dest = (rawMounts || []).find((d) => d.id === id);
      if (!dest) {
        throw createAppError('BACKUP_DEST_UNKNOWN', 'Invalid backup destination', 'Mount is not configured for backup');
      }
      const mountPath = dest.mountPath;
      if (!mountPath) continue;
      if (dest.type === 'smb') {
        const { mounted } = await getMountStatus(mountPath);
        if (!mounted) {
          try {
            await mountSMB(dest.share, mountPath, { username: dest.username, password: dest.password });
          } catch (mountErr) {
            throw createAppError(
              'BACKUP_MOUNT_FAILED',
              'Network mount failed',
              mountErr.message || 'Could not mount network share. Mount it from Host Mgmt first.',
            );
          }
        }
      }
      destinations.push({
        id,
        path: mountPath,
        label: (dest.label && dest.label.trim()) || (dest.type === 'smb' ? 'Network' : 'Disk'),
      });
    } else {
      throw createAppError('BACKUP_DEST_UNKNOWN', 'Invalid backup destination', `Unknown or disallowed destination id: ${id}`);
    }
  }

  if (destinations.length === 0) {
    throw createAppError('BACKUP_DEST_NONE', 'No backup destination', 'No configured destination resolved for the requested ids');
  }
  return destinations;
}
