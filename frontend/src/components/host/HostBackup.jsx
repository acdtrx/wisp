import { useState } from 'react';
import { Archive } from 'lucide-react';

import SectionCard from '../shared/SectionCard.jsx';
import { useSettingsForm } from '../../hooks/useSettingsForm.js';
import { updateSettings } from '../../api/settings.js';
import SettingsGate from '../shared/SettingsGate.jsx';
import { errorText } from '../../api/errors.js';

export default function HostBackup() {
  const [backupLocalPath, setBackupLocalPath] = useState('');
  const [backupMountId, setBackupMountId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const { settings, sent, save } = useSettingsForm((loaded) => {
    setBackupLocalPath(loaded.backupLocalPath ?? '');
    setBackupMountId(loaded.backupMountId ?? '');
  });

  const saved = sent ?? {
    backupLocalPath: settings?.backupLocalPath ?? '',
    backupMountId: settings?.backupMountId ?? '',
  };
  const dirty = backupLocalPath !== saved.backupLocalPath || (backupMountId || '') !== (saved.backupMountId || '');

  const handleSave = async () => {
    setError(null);
    setSaving(true);
    try {
      await save({ backupLocalPath, backupMountId }, () => updateSettings({
        backupLocalPath: backupLocalPath.trim(),
        backupMountId: backupMountId ? backupMountId : null,
      }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const networkOptions = (settings?.mounts || []).filter((m) => m.type === 'smb');

  const controlHeightClass = 'h-9 py-0 leading-normal';

  return (
    <SectionCard
      title="Backup"
      titleIcon={<Archive size={14} strokeWidth={2} />}
      helpText="Local backups are written here under VM name / timestamp. The chosen Network mount, when set, also appears as a destination in each VM's backup dialog."
      onSave={handleSave}
      saving={saving}
      isDirty={dirty}
      error={error}
    >
      <SettingsGate>
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
              value={backupMountId}
              onChange={(e) => setBackupMountId(e.target.value)}
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
      </div>
      </SettingsGate>
    </SectionCard>
  );
}
