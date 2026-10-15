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

/**
 * Run one backup per destination, in order, as a single job's progress
 * stream (VM and container backups, manual and scheduled).
 *
 * Each destination owns an equal slice of the job's 0–100% bar. With several
 * destinations, progress text and a failing destination's error message are
 * prefixed with its label. A finished destination emits `destination-done` —
 * never `done`: only the job store's completion emits the terminal `done`, so
 * a later destination's failure still reaches the client as the job's error.
 *
 * @template T
 * @param {Array<{ id: string, path: string, label: string }>} destinations - from resolveBackupDestinations
 * @param {object} opts
 * @param {(event: object) => void} opts.push - job event sink (e.g. `(ev) => backupJobStore.pushEvent(jobId, ev)`)
 * @param {(dest: { id: string, path: string, label: string },
 *          onProgress: (ev: { step: string, percent?: number, currentFile?: string }) => void) => Promise<T>} opts.backupOne
 * @param {(dest: { id: string, path: string, label: string }) => Promise<void>} [opts.afterEach] - runs after a destination finished (e.g. retention pruning)
 * @returns {Promise<T>} the last destination's result
 */
export async function backupToEachDestination(destinations, { push, backupOne, afterEach }) {
  const multi = destinations.length > 1;
  let lastResult;
  let lastKey = null;
  for (const [index, dest] of destinations.entries()) {
    const base = (index / destinations.length) * 100;
    const span = 100 / destinations.length;
    try {
      lastResult = await backupOne(dest, (ev) => {
        const out = {
          step: ev.step,
          percent: ev.percent != null ? Math.round(base + (ev.percent / 100) * span) : undefined,
          currentFile: multi && ev.currentFile ? `${dest.label}: ${ev.currentFile}` : ev.currentFile,
        };
        /* Scaling into a slice maps several manager percents onto one job percent — skip repeats. */
        const key = `${out.step}|${out.percent}|${out.currentFile}`;
        if (key === lastKey) return;
        lastKey = key;
        push(out);
      });
    } catch (err) {
      if (multi) err.message = `${dest.label}: ${err.message}`;
      throw err;
    }
    push({
      step: 'destination-done',
      destinationId: dest.id,
      percent: Math.round(base + span),
      currentFile: `${dest.label} backup complete`,
    });
    if (afterEach) await afterEach(dest);
  }
  return lastResult;
}
