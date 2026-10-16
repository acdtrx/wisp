/**
 * A VM backup holds the guest's disks — and with them whatever secrets the
 * guest keeps — plus cloud-init.json's password hash. Since 2026-10-16 a VM
 * backup's timestamp directory is created 0700 and its files 0600; earlier
 * releases left the directory, disks, domain.xml and manifest at the umask
 * default (0755 / 0644; VARS.fd and cloud-init.json were already 0600). This
 * tightens the existing ones through vmManager under the backup roots the
 * backend lists — the local path, and the backup mount when it is mounted. An
 * unmounted backup mount is skipped (logged, not mounted here); its backups
 * keep their modes until tightened by hand (`chmod -R go-rwx <root>/vms`).
 * A mount whose filesystem has no Unix modes (CIFS, vfat) keeps its
 * mount-wide mode; that is recorded, not an error.
 *
 * Backward-compatible: the previous release reads (restore) and removes
 * (delete) backups as the same deploy user. Idempotent: an entry with no
 * group/other bits is left alone.
 */
import { describeModeChanges } from '../src/lib/storage/index.js';
import { getSettings, listBackupDestinationsWithMountCheck, listConfiguredBackupRoots } from '../src/lib/settings.js';

export const id = '0006-vm-backup-file-modes';
export const description = 'VM backups are owner-only (directory 0700, files 0600)';

export async function run(ctx) {
  const settings = await getSettings();
  const roots = (await listBackupDestinationsWithMountCheck(settings)).map((d) => d.path);
  for (const root of listConfiguredBackupRoots(settings)) {
    if (!roots.includes(root)) ctx.log.warn({ root }, 'Backup mount not mounted — its VM backups are left as they are');
  }
  const changes = await ctx.vmManager.tightenVMBackupFileModes(roots, { dryRun: ctx.dryRun });
  for (const line of describeModeChanges(changes)) ctx.recordChange(line);
}
