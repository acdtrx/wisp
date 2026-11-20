const LOCAL_DEFAULT = '/var/lib/wisp/backups';

/**
 * Where a workload's backup can go, from the settings record: Local, and the backup
 * mount when one is set. Before the settings load, none; when they failed to load,
 * Local at its default path, flagged as a fallback.
 */
export function backupDestinations(settingsRecord) {
  const settings = settingsRecord.data;
  if (!settings) {
    return settingsRecord.status === 'error' ? [{ id: 'local', label: 'Local', path: LOCAL_DEFAULT, fallback: true }] : [];
  }
  const dests = [{ id: 'local', label: 'Local', path: settings.backupLocalPath || LOCAL_DEFAULT }];
  if (settings.backupMountId) {
    const m = (settings.mounts || []).find((x) => x.id === settings.backupMountId);
    if (m?.mountPath) dests.push({ id: m.id, label: m.label || 'Network', path: m.mountPath });
  }
  return dests;
}
