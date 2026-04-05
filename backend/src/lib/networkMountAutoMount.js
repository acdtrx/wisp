/**
 * On backend start, ensure configured network (SMB) mounts are mounted.
 */
import { getRawNetworkMounts } from './settings.js';
import { getMountStatus, mountSMB } from './smbMount.js';

/**
 * Check each SMB network mount and mount it if not already mounted.
 * @param {{ info: (obj: object, msg: string) => void, warn: (obj: object, msg: string) => void }} log - Logger (e.g. app.log)
 */
export async function ensureNetworkMounts(log) {
  const mounts = await getRawNetworkMounts();
  const smbMounts = mounts.filter((d) => d && (d.share || '').trim());
  if (smbMounts.length === 0) return;

  for (const d of smbMounts) {
    const mountPath = (d.mountPath || d.path || '').trim();
    if (!mountPath.startsWith('/')) continue;
    try {
      const { mounted } = await getMountStatus(mountPath);
      if (mounted) continue;
      await mountSMB(d.share, mountPath, {
        username: d.username,
        password: d.password,
      });
      log.info({ id: d.id, mountPath }, 'Network mount mounted at startup');
    } catch (err) {
      /* non-fatal — Host Mgmt can prompt manual mount */
      log.warn({ err, id: d.id, mountPath: d.mountPath || d.path }, 'Network mount auto-mount failed');
    }
  }
}
