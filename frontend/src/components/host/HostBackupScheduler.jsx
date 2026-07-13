import { useState, useEffect } from 'react';
import { CalendarClock } from 'lucide-react';

import SectionCard from '../shared/SectionCard.jsx';
import Toggle from '../shared/Toggle.jsx';
import { useSettingsStore } from '../../store/settingsStore.js';
import { updateSettings } from '../../api/settings.js';

const DEFAULT_SCHEDULE = {
  enabled: false,
  time: '03:00',
  destinationIds: ['local'],
  retainDays: 7,
  retainWeeks: 4,
};

function fromSettings(settings) {
  const s = settings?.backupSchedule || DEFAULT_SCHEDULE;
  return {
    enabled: s.enabled === true,
    time: s.time || DEFAULT_SCHEDULE.time,
    destinationIds: Array.isArray(s.destinationIds) && s.destinationIds.length > 0
      ? [...s.destinationIds]
      : ['local'],
    retainDays: String(s.retainDays ?? DEFAULT_SCHEDULE.retainDays),
    retainWeeks: String(s.retainWeeks ?? DEFAULT_SCHEDULE.retainWeeks),
  };
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export default function HostBackupScheduler() {
  const settings = useSettingsStore((s) => s.settings);
  const loadSettings = useSettingsStore((s) => s.loadSettings);

  const [form, setForm] = useState(() => fromSettings(settings));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (settings) setForm(fromSettings(settings));
  }, [settings]);

  const dirty = JSON.stringify(form) !== JSON.stringify(fromSettings(settings));

  /* Local, plus the mount chosen in the Backup section above (when set). */
  const backupMount = settings?.backupMountId
    ? (settings?.mounts || []).find((m) => m.id === settings.backupMountId)
    : null;
  const destinationOptions = [
    { id: 'local', label: 'Local' },
    ...(backupMount
      ? [{ id: backupMount.id, label: backupMount.label?.trim() || 'Network' }]
      : []),
  ];

  const toggleDestination = (id) => {
    setForm((prev) => {
      const has = prev.destinationIds.includes(id);
      /* At least one destination must stay selected. */
      if (has && prev.destinationIds.length === 1) return prev;
      return {
        ...prev,
        destinationIds: has
          ? prev.destinationIds.filter((d) => d !== id)
          : [...prev.destinationIds, id],
      };
    });
  };

  const handleSave = async () => {
    setError(null);
    setSaving(true);
    try {
      await updateSettings({
        backupSchedule: {
          enabled: form.enabled,
          time: form.time,
          destinationIds: form.destinationIds,
          retainDays: clampInt(form.retainDays, 1, 365, DEFAULT_SCHEDULE.retainDays),
          retainWeeks: clampInt(form.retainWeeks, 0, 52, DEFAULT_SCHEDULE.retainWeeks),
        },
      });
      await loadSettings();
    } catch (err) {
      setError(err.message || 'Failed to save backup schedule');
    } finally {
      setSaving(false);
    }
  };

  const controlHeightClass = 'h-9 py-0 leading-normal';

  return (
    <SectionCard
      title="Backup Scheduler"
      titleIcon={<CalendarClock size={14} strokeWidth={2} />}
      helpText="Backs up every container with Auto Backup enabled, daily at the set time (running containers are briefly paused while archived). Retention keeps the newest scheduled backup per day for the daily window, then one per week — manual backups are never pruned. Runs only while the server is up; a missed time is skipped until the next day."
      onSave={handleSave}
      saving={saving}
      isDirty={dirty}
      error={error}
    >
      <div className="flex flex-wrap gap-x-6 gap-y-3 items-end">
        <div className="shrink-0">
          <label className="block text-[11px] font-medium uppercase tracking-wider text-text-muted mb-1">
            Enabled
          </label>
          <div className={`flex items-center ${controlHeightClass}`}>
            <Toggle
              checked={form.enabled}
              onChange={(v) => setForm((prev) => ({ ...prev, enabled: v }))}
            />
          </div>
        </div>
        <div className="w-28 shrink-0">
          <label className="block text-[11px] font-medium uppercase tracking-wider text-text-muted mb-1">
            Time
          </label>
          <input
            type="time"
            value={form.time}
            onChange={(e) => setForm((prev) => ({ ...prev, time: e.target.value || prev.time }))}
            className={`input-field w-full text-sm ${controlHeightClass}`}
          />
        </div>
        <div className="shrink-0">
          <label className="block text-[11px] font-medium uppercase tracking-wider text-text-muted mb-1">
            Destinations
          </label>
          <div className={`flex items-center gap-4 ${controlHeightClass}`}>
            {destinationOptions.map((d) => (
              <label key={d.id} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.destinationIds.includes(d.id)}
                  onChange={() => toggleDestination(d.id)}
                  className="rounded-sm border-surface-border"
                />
                <span className="text-sm text-text-primary">{d.label}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="w-24 shrink-0">
          <label className="block text-[11px] font-medium uppercase tracking-wider text-text-muted mb-1">
            Keep days
          </label>
          <input
            type="number"
            min={1}
            max={365}
            value={form.retainDays}
            onChange={(e) => setForm((prev) => ({ ...prev, retainDays: e.target.value }))}
            className={`input-field input-field-no-spinner w-full text-right text-sm ${controlHeightClass}`}
          />
        </div>
        <div className="w-24 shrink-0">
          <label className="block text-[11px] font-medium uppercase tracking-wider text-text-muted mb-1">
            Keep weeks
          </label>
          <input
            type="number"
            min={0}
            max={52}
            value={form.retainWeeks}
            onChange={(e) => setForm((prev) => ({ ...prev, retainWeeks: e.target.value }))}
            className={`input-field input-field-no-spinner w-full text-right text-sm ${controlHeightClass}`}
          />
        </div>
      </div>
    </SectionCard>
  );
}
