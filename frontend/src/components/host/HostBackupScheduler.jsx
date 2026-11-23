import { useState } from 'react';
import { Pencil } from 'lucide-react';

import { updateSettings } from '../../api/settings.js';
import { useCommand } from '../../hooks/useCommand.js';
import { useRecord } from '../../hooks/useRecord.js';
import { autoFocusField } from '../../lib/focus.js';
import { RECORD } from '../../store/records.js';
import { backupDestinations } from '../../utils/backupDestinations.js';
import CommandErrors from '../shared/CommandErrors.jsx';
import { FormCheckbox, FormField } from '../shared/FormModalChrome.jsx';
import GroupAction from '../shared/GroupAction.jsx';
import Card from '../shared/Card.jsx';
import GroupSwitch from '../shared/GroupSwitch.jsx';
import RecordGate from '../shared/RecordGate.jsx';
import ValueRows from '../shared/ValueRows.jsx';
import SettingsEditor from './SettingsEditor.jsx';
import { keepText, scheduleForm, scheduleOf, scheduleProblem, scheduleSent } from './settingsForms.js';

/**
 * Scheduled backups (docs/specs/BACKUPS.md, Scheduled backups): daily, of every
 * container with Auto Backup on. On or off is a switch; the Edit holds the time, the
 * destinations and how long backups are kept.
 */
export default function HostBackupScheduler() {
  const record = useRecord(RECORD.SETTINGS);
  const [editing, setEditing] = useState(false);
  const act = useCommand();
  return (
    <Card
      title="Scheduled backups"
      actions={<GroupAction icon={Pencil} label="Edit the backup schedule" reason={record.data ? undefined : 'the settings are loading'} onClick={() => setEditing(true)} />}
    >
      <RecordGate record={record} what="settings">
        {(settings) => {
          const schedule = scheduleOf(settings);
          const options = backupDestinations(settings);
          const nameOf = (id) => options.find((d) => d.id === id)?.label ?? id;
          return (
            <>
              <ValueRows
                rows={[
                  { label: 'Time', value: `Daily at ${schedule.time}` },
                  { label: 'Destinations', value: schedule.destinationIds.map(nameOf).join(', ') },
                  { label: 'Keeps', value: keepText(schedule) },
                ]}
              />
              <GroupSwitch
                label="Back up on schedule"
                hint="Every container with Auto Backup on; a running one is paused while it is archived. Manual backups are never pruned."
                checked={schedule.enabled === true}
                busy={act.isBusy('enabled')}
                onChange={(on) => act.run(() => updateSettings({ backupSchedule: { enabled: on } }), {
                  key: 'enabled', about: `Couldn't turn scheduled backups ${on ? 'on' : 'off'}`,
                })}
              />
              <CommandErrors className="mt-2" commands={[act]} prefix={(_key, _cmd, about) => about} />
              {editing && (
                <SettingsEditor
                  title="Backup schedule"
                  initial={() => scheduleForm(settings)}
                  sent={(form) => scheduleSent(form, settings)}
                  problem={scheduleProblem}
                  send={(changed) => updateSettings({ backupSchedule: changed })}
                  onClose={() => setEditing(false)}
                >
                  {({ form, setField }) => (
                    <>
                      <FormField label="Time" htmlFor="schedule-time" hint="Daily, the host’s time. A time missed while the server is down is skipped until the next day.">
                        <input id="schedule-time" ref={autoFocusField} type="time" value={form.time} onChange={(e) => setField('time', e.target.value)} className="input-field w-32" />
                      </FormField>
                      <fieldset>
                        <legend className="mb-1 text-xs font-medium text-text-secondary">Destinations</legend>
                        <div className="flex flex-wrap gap-4">
                          {options.map((d) => (
                            <FormCheckbox
                              key={d.id}
                              label={d.label}
                              hint={d.path}
                              checked={form.destinationIds.includes(d.id)}
                              onChange={(e) => setField('destinationIds', e.target.checked
                                ? [...form.destinationIds, d.id]
                                : form.destinationIds.filter((id) => id !== d.id))}
                            />
                          ))}
                        </div>
                        {options.length === 1 && <p className="mt-1 text-[11px] text-text-muted">Set a second destination in Backup to add one here.</p>}
                      </fieldset>
                      <div className="grid grid-cols-2 gap-3">
                        <FormField label="Keep days" htmlFor="schedule-days" hint="The newest per day, 1 to 365.">
                          <input id="schedule-days" type="text" inputMode="numeric" value={form.retainDays} onChange={(e) => setField('retainDays', e.target.value)} className="input-field" />
                        </FormField>
                        <FormField label="Keep weeks" htmlFor="schedule-weeks" hint="Then one per week, 0 to 52.">
                          <input id="schedule-weeks" type="text" inputMode="numeric" value={form.retainWeeks} onChange={(e) => setField('retainWeeks', e.target.value)} className="input-field" />
                        </FormField>
                      </div>
                    </>
                  )}
                </SettingsEditor>
              )}
            </>
          );
        }}
      </RecordGate>
    </Card>
  );
}
