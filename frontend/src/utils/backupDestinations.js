const LOCAL_DEFAULT = '/var/lib/wisp/backups';

/**
 * Where a workload's backup can go, from the settings: Local, and the backup mount
 * when one is set (labelled `Network` when it has no label). The one list every
 * destination picker shows; a picker waits for the settings to load.
 */
export function backupDestinations(settings) {
  const dests = [{ id: 'local', label: 'Local', path: settings.backupLocalPath || LOCAL_DEFAULT }];
  const mount = settings.backupMountId ? (settings.mounts || []).find((m) => m.id === settings.backupMountId) : null;
  if (mount?.mountPath) dests.push({ id: mount.id, label: mount.label?.trim() || 'Network', path: mount.mountPath });
  return dests;
}
