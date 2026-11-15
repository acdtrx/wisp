import { X } from 'lucide-react';
import { useSettingsStore } from '../../store/settingsStore.js';

/**
 * A settings load failure while settings are on screen, shown until dismissed: a
 * failed refresh (the last good settings stay), or a first load that failed and
 * succeeded later. Before any settings load, SettingsGate shows the error instead.
 */
export default function SettingsRefreshNotice() {
  const hasSettings = useSettingsStore((s) => s.settings != null);
  const error = useSettingsStore((s) => s.error);
  const errorDetail = useSettingsStore((s) => s.errorDetail);
  const errorBeforeFirstLoad = useSettingsStore((s) => s.errorBeforeFirstLoad);
  const dismissError = useSettingsStore((s) => s.dismissError);
  if (!hasSettings || !error) return null;
  const detail = errorDetail && errorDetail !== error ? `${error}: ${errorDetail}` : error;
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-2 rounded-md border border-status-stopped/30 bg-status-stopped-soft px-3 py-2 text-xs text-status-stopped"
    >
      <span className="min-w-0 flex-1">
        {errorBeforeFirstLoad
          ? `Settings failed to load at first (${detail}); they have loaded since.`
          : `Couldn't refresh settings — ${detail}`}
      </span>
      <button
        type="button"
        onClick={dismissError}
        className="shrink-0 rounded-sm p-2 lg:p-1 hover:bg-status-stopped-soft transition-colors duration-150"
        title="Dismiss"
        aria-label="Dismiss settings refresh error"
      >
        <X size={14} />
      </button>
    </div>
  );
}
