/**
 * App-declared secret files (tiny-samba `tiny-samba-passwords`, zot `htpasswd`
 * / `session-keys` and its OIDC `config-json`) are written 0600 since
 * 2026-10-16; earlier releases left them at the umask default (0644). This
 * tightens the existing ones through containerManager. The container keeps
 * reading them: its process runs as the deploy user that owns the file, or
 * with runAsRoot as root through the mount's idmap (checked with tiny-samba:
 * start, reload and SMB logins work at 0600). The bind mount is the same
 * inode, so a running container sees the new mode at once — no restart.
 *
 * Backward-compatible: the previous release rewrites these files in place,
 * which keeps the mode. Idempotent: a file with no group/other bits is left
 * alone.
 */
import { appSecretMountNames } from '../src/lib/containerApps/index.js';

export const id = '0004-app-secret-file-modes';
export const description = 'App secret files (tiny-samba passwords, zot htpasswd/session keys) are mode 0600';

const MODE = 0o600;

export async function run(ctx) {
  const containers = await ctx.containerManager.listContainers();
  for (const { name } of containers) {
    const config = await ctx.containerManager.getContainerConfig(name);
    const secrets = appSecretMountNames(config);
    if (secrets.size === 0) continue;
    for (const mount of config.mounts || []) {
      if (mount.type !== 'file' || mount.sourceId || !secrets.has(mount.name)) continue;
      const mode = await ctx.containerManager.getMountFileMode(name, mount.name);
      if (mode == null || (mode & 0o077) === 0) continue;
      ctx.recordChange(`${name}: ${mount.name} mode ${octal(mode)} → ${octal(MODE)}`);
      if (!ctx.dryRun) await ctx.containerManager.setMountFileMode(name, mount.name, MODE);
    }
  }
}

function octal(mode) {
  return `0${mode.toString(8).padStart(3, '0')}`;
}
