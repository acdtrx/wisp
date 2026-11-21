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

/**
 * The destinations in the order a backup writes them: Local first, then the mounts in
 * the settings' order (the server stops at the first that fails, so Local is never
 * skipped for a mount's failure); an id the settings no longer list keeps its place
 * after them. The order they were ticked in is no change.
 */
export function destinationOrder(ids, mounts) {
  const list = Array.isArray(ids) ? ids : [];
  const known = (Array.isArray(mounts) ? mounts : []).filter((m) => m && list.includes(m.id)).map((m) => m.id);
  return [
    ...(list.includes('local') ? ['local'] : []),
    ...known,
    ...list.filter((id) => id !== 'local' && !known.includes(id)),
  ];
}
