import { useState, useEffect } from 'react';
import { Archive } from 'lucide-react';

import SectionCard from '../shared/SectionCard.jsx';
import { useSettingsStore } from '../../store/settingsStore.js';
import { updateSettings } from '../../api/settings.js';

export default function HostBackup() {
  const settings = useSettingsStore((s) => s.settings);
  const loadSettings = useSettingsStore((s) => s.loadSettings);

  const [backupLocalPath, setBackupLocalPath] = useState('');
  const [backupNetworkMountId, setBackupNetworkMountId] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (settings) {
      setBackupLocalPath(settings.backupLocalPath ?? '');
      setBackupNetworkMountId(settings.backupNetworkMountId ?? '');
    }
  }, [settings]);

  useEffect(() => {
    const lp = settings?.backupLocalPath ?? '';
    const savedNet = settings?.backupNetworkMountId ?? '';
    setDirty(backupLocalPath !== lp || (backupNetworkMountId || '') !== (savedNet || ''));
  }, [settings, backupLocalPath, backupNetworkMountId]);

  const handleSave = async () => {
    setError(null);
    setSaving(true);
    try {
      const updated = await updateSettings({
        backupLocalPath: backupLocalPath.trim() || undefined,
        backupNetworkMountId: backupNetworkMountId ? backupNetworkMountId : null,
      });
      await loadSettings();
      setBackupLocalPath(updated.backupLocalPath ?? '');
      setBackupNetworkMountId(updated.backupNetworkMountId ?? '');
      setDirty(false);
    } catch (err) {
      setError(err.message || 'Failed to save backup settings');
    } finally {
      setSaving(false);
    }
  };

  const networkOptions = settings?.networkMounts || [];

  const controlHeightClass = 'h-9 py-0 leading-normal';

  return (
    <SectionCard title="Backup" titleIcon={<Archive size={14} strokeWidth={2} />} onSave={handleSave} saving={saving} isDirty={dirty} error={error}>
      <div className="space-y-2">
        <div className="flex flex-wrap gap-x-6 gap-y-3 items-end">
          <div className="min-w-0 flex-1 basis-[min(100%,18rem)] max-w-2xl">
            <label className="block text-[11px] font-medium uppercase tracking-wider text-text-muted mb-1">
              Local backup path
            </label>
            <input
              type="text"
              value={backupLocalPath}
              onChange={(e) => setBackupLocalPath(e.target.value)}
              placeholder="/var/lib/wisp/backups"
              className={`input-field font-mono placeholder:text-text-muted w-full ${controlHeightClass}`}
            />
          </div>
          <div className="w-full sm:w-64 shrink-0">
            <label className="block text-[11px] font-medium uppercase tracking-wider text-text-muted mb-1">
              Network mount for backup
            </label>
            <select
              value={backupNetworkMountId}
              onChange={(e) => setBackupNetworkMountId(e.target.value)}
              className={`input-field w-full text-sm ${controlHeightClass}`}
            >
              <option value="">(none)</option>
              {networkOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label?.trim() || m.id}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className="text-[10px] text-text-muted">
          Local: VM backups use this directory as <span className="font-mono">VM name / timestamp</span>. Network: when set,
          that mount from Network Storage appears in the VM Overview backup dialog alongside Local.
        </p>
      </div>
    </SectionCard>
  );
}
