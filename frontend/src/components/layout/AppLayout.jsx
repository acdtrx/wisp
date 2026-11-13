import { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import TopBar from './TopBar';
import LeftPanel from './LeftPanel';
import { useSettingsStore } from '../../store/settingsStore.js';
import { useBackgroundJobsStore } from '../../store/backgroundJobsStore.js';

export default function AppLayout() {
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const settings = useSettingsStore((s) => s.settings);

  useEffect(() => {
    if (!settings) {
      document.title = 'Wisp';
      return () => {
        document.title = 'Wisp';
      };
    }
    const serverName = settings.serverName ?? 'My Server';
    document.title = `${serverName} — Wisp`;
    return () => {
      document.title = 'Wisp';
    };
  }, [settings]);

  useEffect(() => {
    /* Non-fatal: settings store tracks error; app shell still renders */
    loadSettings().catch(() => {});
  }, [loadSettings]);

  useEffect(() => {
    /* Non-fatal on failure: the tray says it may be missing jobs, with a retry. */
    useBackgroundJobsStore.getState().hydrate();
  }, []);

  /* px-safe keeps the shell out of the landscape notch, which viewport-fit=cover would
     otherwise let it slide under. The bottom inset is handled by the stats bars and the
     drawer footer, so their own backgrounds paint the home-indicator strip. */
  return (
    <div className="flex h-dvh flex-col px-safe">
      <TopBar />

      <div className="flex flex-1 overflow-hidden">
        <LeftPanel />

        <main data-wisp-main className="flex flex-1 flex-col overflow-hidden bg-surface">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
