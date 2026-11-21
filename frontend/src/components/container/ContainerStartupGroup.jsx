import { Archive } from 'lucide-react';

import { useRecord } from '../../hooks/useRecord.js';
import { useBackupsStore } from '../../store/backupsStore.js';
import { RECORD } from '../../store/records.js';
import { backupDestinations } from '../../utils/backupDestinations.js';
import { formatRelativeTime } from '../../utils/formatters.js';
import GroupAction from '../shared/GroupAction.jsx';
import GroupCard from '../shared/GroupCard.jsx';
import GroupSwitch from '../shared/GroupSwitch.jsx';
import ValueRows from '../shared/ValueRows.jsx';

/** What the last backup attempt says on the page (none: null). */
function lastBackupText(attempt, settings) {
  if (!attempt) return 'None yet';
  const when = formatRelativeTime(attempt.at);
  if (!attempt.ok) return `Failed ${when}${attempt.detail ? `: ${attempt.detail}` : ''}`;
  const dests = settings ? backupDestinations(settings) : [];
  const where = (attempt.destinationIds ?? []).map((id) => dests.find((d) => d.id === id)?.label ?? id).join(', ');
  return where ? `${when}, to ${where}` : when;
}

/**
 * When the container starts on its own and whether the nightly backup takes it: two
 * switches that act at once, and Back up now (`onBackUp` opens the backup dialog).
 */
export default function ContainerStartupGroup({ config, busy, backupReason, act, update, onBackUp }) {
  const attempt = useBackupsStore((s) => s.data?.containers?.[config.name] ?? null);
  const settings = useRecord(RECORD.SETTINGS).data;

  const toggle = (field, on, what) => act.run(() => update({ [field]: on }), {
    key: field, about: `Couldn't turn ${what} ${on ? 'on' : 'off'}`,
  });

  return (
    <GroupCard
      title="Start-up and backups"
      actions={<GroupAction icon={Archive} label="Back up now" reason={backupReason} onClick={onBackUp} />}
    >
      <GroupSwitch
        label="Start with the host"
        hint="Started when the host boots and whenever Wisp starts."
        checked={config.autostart === true}
        onChange={(on) => toggle('autostart', on, 'start with the host')}
        busy={act.isBusy('autostart')}
        reason={busy}
      />
      <GroupSwitch
        label="Include in the nightly backup"
        hint="A running container pauses for a moment while it is archived."
        checked={config.autoBackup === true}
        onChange={(on) => toggle('autoBackup', on, 'the nightly backup')}
        busy={act.isBusy('autoBackup')}
        reason={busy}
      />
      <div className={`border-t border-surface-border pt-1.5 ${attempt && !attempt.ok ? '[&_dd]:text-status-stopped' : ''}`}>
        <ValueRows rows={[{ label: 'Last backup', value: lastBackupText(attempt, settings) }]} />
      </div>
    </GroupCard>
  );
}
