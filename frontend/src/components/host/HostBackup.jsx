import { Archive } from 'lucide-react';

import SectionCard from '../shared/SectionCard.jsx';
import { updateSettings } from '../../api/settings.js';
import RecordGate from '../shared/RecordGate.jsx';
import { useCommand } from '../../hooks/useCommand.js';
import { RECORD } from '../../store/records.js';
import { useRecord } from '../../hooks/useRecord.js';
import { useForm } from '../../hooks/useForm.js';

const formFromSettings = (settings) => ({
  backupLocalPath: settings.backupLocalPath ?? '',
  backupMountId: settings.backupMountId ?? '',
});

export default function HostBackup() {
  const settingsRecord = useRecord(RECORD.SETTINGS);
  const settings = settingsRecord.data;
  const { form, setField, dirty, saving, save } = useForm(settingsRecord, formFromSettings);
  const command = useCommand();

  const handleSave = () => save((sent) => command.run(() => updateSettings({
    backupLocalPath: sent.backupLocalPath.trim(),
    backupMountId: sent.backupMountId ? sent.backupMountId : null,
  })));

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
      commands={[command]}
    >
      <RecordGate record={settingsRecord} what="settings">
        {() => (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-x-6 gap-y-3 items-end">
              <div className="min-w-0 flex-1 basis-[min(100%,18rem)] max-w-2xl">
                <label className="block text-[11px] font-medium uppercase tracking-wider text-text-muted mb-1">
                  Local backup path
                </label>
                <input
                  type="text"
                  value={form.backupLocalPath}
                  onChange={(e) => setField('backupLocalPath', e.target.value)}
                  placeholder="/var/lib/wisp/backups"
                  className={`input-field font-mono placeholder:text-text-muted w-full ${controlHeightClass}`}
                />
              </div>
              <div className="w-full sm:w-64 shrink-0">
                <label className="block text-[11px] font-medium uppercase tracking-wider text-text-muted mb-1">
                  Network mount for backup
                </label>
                <select
                  value={form.backupMountId}
                  onChange={(e) => setField('backupMountId', e.target.value)}
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
        )}
      </RecordGate>
    </SectionCard>
  );
}
