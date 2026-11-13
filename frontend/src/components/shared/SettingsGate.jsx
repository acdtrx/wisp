import { Loader2 } from 'lucide-react';
import { useSettingsStore } from '../../store/settingsStore.js';

/**
 * Renders its children once the settings have loaded; until then a loading
 * line, or the load error with a retry — never a form full of defaults that
 * a Save would write back over the real settings.
 */
export default function SettingsGate({ children, label = 'settings' }) {
  const settings = useSettingsStore((s) => s.settings);
  const error = useSettingsStore((s) => s.error);
  const loading = useSettingsStore((s) => s.loading);
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  if (settings) return children;
  if (error && !loading) {
    return (
      <p className="text-xs text-status-stopped" role="alert">
        Couldn't load the {label}: {error}{' '}
        <button type="button" onClick={() => loadSettings().catch(() => {})} className="font-medium underline">
          Retry
        </button>
      </p>
    );
  }
  return (
    <p className="flex items-center gap-2 text-xs text-text-muted">
      <Loader2 size={14} className="animate-spin" aria-hidden /> Loading {label}…
    </p>
  );
}
