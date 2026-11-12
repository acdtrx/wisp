/**
 * Every backup manifest records its `origin` (`manual` | `scheduled`) since
 * scheduled container backups arrived (2026-07-14); VM and container backups
 * written earlier have none, and the listings read a missing origin as manual.
 * This writes `origin: "manual"` into those manifests — what they were, since
 * nothing was scheduled before the field existed — through vmManager and
 * containerManager, under the backup roots the backend lists: the local path,
 * and the backup mount when it is mounted. An unmounted backup mount is
 * skipped (logged, not mounted here); its old backups keep no origin.
 *
 * Backward-compatible: the previous release reads `manual` itself.
 * Idempotent: a manifest with an origin is left alone.
 */
import { getSettings, listBackupDestinationsWithMountCheck, listConfiguredBackupRoots } from '../src/lib/settings.js';

export const id = '0008-backup-origin';
export const description = 'Backup manifests without an origin record origin: manual';

export async function run(ctx) {
  const settings = await getSettings();
  const destinations = await listBackupDestinationsWithMountCheck(settings);
  const listed = destinations.map((d) => d.path);
  for (const root of listConfiguredBackupRoots(settings)) {
    if (!listed.includes(root)) ctx.log.warn({ root }, 'Backup mount not mounted — its backups are left as they are');
  }

  const vmBackups = await ctx.vmManager.listBackups(destinations);
  for (const b of vmBackups) {
    if (b.origin != null) continue;
    ctx.recordChange(`${b.path}: origin → manual`);
    if (!ctx.dryRun) await ctx.vmManager.setVMBackupOrigin(b.path, 'manual');
  }

  const containerBackups = await ctx.containerManager.listContainerBackups(destinations);
  for (const b of containerBackups) {
    if (b.origin != null) continue;
    ctx.recordChange(`${b.path}: origin → manual`);
    if (!ctx.dryRun) await ctx.containerManager.setContainerBackupOrigin(b.path, 'manual');
  }
}
