/**
 * `container.json` holds secret env values in plaintext (Caddy's DNS token,
 * zot's OIDC secret, …) and container backups carry it plus the mount data.
 * Since 2026-10-16 a container directory is created 0700, `container.json` is
 * written 0600, and a container backup's timestamp directory is 0700 with its
 * files 0600; earlier releases left them at the umask default (0755 / 0644).
 * This tightens the existing ones through containerManager: every directory
 * under `containersPath` and its `container.json`, and every container backup
 * under the backup roots the backend lists — the local path, and the backup
 * mount when it is mounted. An unmounted backup mount is skipped (logged, not
 * mounted here); its backups keep their modes until tightened by hand
 * (`chmod -R go-rwx <root>/containers`).
 *
 * The containers never read these: containerd and runc (root) bind-mount
 * `files/` and open the run log themselves, and a container sees only its
 * mount points. A mount whose filesystem has no Unix modes (CIFS, vfat) keeps
 * its mount-wide mode; that is recorded, not an error.
 *
 * Backward-compatible: the previous release reads and rewrites these files as
 * the same deploy user. Idempotent: an entry with no group/other bits is left
 * alone.
 */
import { describeModeChanges } from '../src/lib/storage/index.js';
import { getSettings, listBackupDestinationsWithMountCheck, listConfiguredBackupRoots } from '../src/lib/settings.js';

export const id = '0005-container-config-modes';
export const description = 'Container directories, container.json and container backups are owner-only (0700 / 0600)';

export async function run(ctx) {
  const { dryRun } = ctx;
  const record = (changes) => describeModeChanges(changes).forEach((line) => ctx.recordChange(line));

  record(await ctx.containerManager.tightenContainerFileModes({ dryRun }));

  const settings = await getSettings();
  const roots = (await listBackupDestinationsWithMountCheck(settings)).map((d) => d.path);
  for (const root of listConfiguredBackupRoots(settings)) {
    if (!roots.includes(root)) ctx.log.warn({ root }, 'Backup mount not mounted — its container backups are left as they are');
  }
  record(await ctx.containerManager.tightenContainerBackupFileModes(roots, { dryRun }));
}
