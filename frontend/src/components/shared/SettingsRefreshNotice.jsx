import { X } from 'lucide-react';
import { useSettingsStore } from '../../store/settingsStore.js';

/**
 * A failed settings reload while the last good settings are on screen: says so
 * until dismissed. Before the first load, SettingsGate shows the error instead.
 */
export default function SettingsRefreshNotice() {
  const hasSettings = useSettingsStore((s) => s.settings != null);
  const error = useSettingsStore((s) => s.error);
  const errorDetail = useSettingsStore((s) => s.errorDetail);
  const dismissError = useSettingsStore((s) => s.dismissError);
  if (!hasSettings || !error) return null;
  const detail = errorDetail && errorDetail !== error ? `${error}: ${errorDetail}` : error;
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-2 rounded-md border border-status-stopped/30 bg-status-stopped-soft px-3 py-2 text-xs text-status-stopped"
    >
      <span className="min-w-0 flex-1">Couldn't refresh settings — {detail}</span>
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
