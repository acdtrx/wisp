/**
 * Wrapper that renders an app's dedicated config component and provides eject functionality.
 */
import { useState } from 'react';
import { Unplug } from 'lucide-react';
import ConfirmDialog from '../components/shared/ConfirmDialog.jsx';
import { getAppEntry } from './appRegistry.js';

export default function AppConfigWrapper({ config, onSave, onRefresh }) {
  const [ejectOpen, setEjectOpen] = useState(false);

  const appEntry = getAppEntry(config.metadata?.app);
  if (!appEntry) return null;

  const AppComponent = appEntry.component;

  const handleAppSave = async (appConfig) => {
    const result = await onSave({ appConfig });
    return result;
  };

  const handleEject = async () => {
    setEjectOpen(false);
    await onSave({ eject: true });
    await onRefresh();
  };

  return (
    <>
      <AppComponent config={config} onSave={handleAppSave} />

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setEjectOpen(true)}
          className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] text-text-muted hover:text-text-primary hover:bg-surface transition-colors duration-150"
        >
          <Unplug size={13} />
          Eject to generic container
        </button>
      </div>

      <ConfirmDialog
        open={ejectOpen}
        title="Eject to Generic Container"
        confirmLabel="Eject"
        onConfirm={handleEject}
        onCancel={() => setEjectOpen(false)}
      >
        <p>
          This will convert to a generic container. You'll see raw environment
          variables and mount files instead of the app configuration UI.
        </p>
        <p className="mt-2 text-xs text-text-muted">
          This cannot be undone. The container will keep its current configuration.
        </p>
      </ConfirmDialog>
    </>
  );
}
