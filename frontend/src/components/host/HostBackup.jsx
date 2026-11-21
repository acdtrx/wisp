import { useState } from 'react';
import { Pencil } from 'lucide-react';

import { updateSettings } from '../../api/settings.js';
import { useRecord } from '../../hooks/useRecord.js';
import { autoFocusField } from '../../lib/focus.js';
import { RECORD } from '../../store/records.js';
import { FormField } from '../shared/FormModalChrome.jsx';
import GroupAction from '../shared/GroupAction.jsx';
import GroupCard from '../shared/GroupCard.jsx';
import RecordGate from '../shared/RecordGate.jsx';
import ValueRows from '../shared/ValueRows.jsx';
import SettingsEditor from './SettingsEditor.jsx';
import { backupForm, backupProblem, backupSent, mountText } from './settingsForms.js';

/**
 * Where backups go (docs/specs/BACKUPS.md, Backup destinations): the local path, and a
 * second destination, any configured mount (an SMB share or an adopted drive).
 */
export default function HostBackup() {
  const record = useRecord(RECORD.SETTINGS);
  const [editing, setEditing] = useState(false);
  return (
    <GroupCard
      title="Backup"
      actions={<GroupAction icon={Pencil} label="Edit where backups go" reason={record.data ? undefined : 'the settings are loading'} onClick={() => setEditing(true)} />}
    >
      <RecordGate record={record} what="settings">
        {(settings) => {
          const mounts = settings.mounts ?? [];
          const second = mounts.find((m) => m.id === settings.backupMountId);
          return (
            <>
              <ValueRows
                rows={[
                  { label: 'Local path', value: settings.backupLocalPath, mono: true },
                  { label: 'Second destination', value: second ? `${mountText(second)} · ${second.mountPath}` : 'None' },
                ]}
              />
              <p className="pb-1 text-[11px] text-text-muted">Backups go under the workload’s name, then the time. Both destinations are offered in each backup dialog.</p>
              {editing && (
                <SettingsEditor
                  title="Backup"
                  initial={() => backupForm(settings)}
                  sent={backupSent}
                  problem={backupProblem}
                  send={updateSettings}
                  onClose={() => setEditing(false)}
                >
                  {({ form, setField }) => (
                    <>
                      <FormField label="Local path" htmlFor="backup-path">
                        <input id="backup-path" ref={autoFocusField} type="text" value={form.backupLocalPath} onChange={(e) => setField('backupLocalPath', e.target.value)} placeholder="/var/lib/wisp/backups" autoComplete="off" spellCheck={false} className="input-field font-mono" />
                      </FormField>
                      <FormField
                        label="Second destination"
                        htmlFor="backup-mount"
                        hint={mounts.length === 0
                          ? 'No mounts yet: add an SMB share or a drive in Storage.'
                          : 'Changing it takes the old one out of the scheduled backups’ destinations.'}
                      >
                        <select id="backup-mount" value={form.backupMountId} onChange={(e) => setField('backupMountId', e.target.value)} className="input-field">
                          <option value="">None</option>
                          {mounts.map((m) => <option key={m.id} value={m.id}>{mountText(m)}</option>)}
                        </select>
                      </FormField>
                    </>
                  )}
                </SettingsEditor>
              )}
            </>
          );
        }}
      </RecordGate>
    </GroupCard>
  );
}
