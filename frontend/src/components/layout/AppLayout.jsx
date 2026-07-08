import { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import TopBar from './TopBar';
import LeftPanel from './LeftPanel';
import { useSettingsStore } from '../../store/settingsStore.js';
import { useBackgroundJobsStore } from '../../store/backgroundJobsStore.js';
import { fetchBackgroundJobs } from '../../api/backgroundJobs.js';

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
    let cancelled = false;
    fetchBackgroundJobs()
      .then(({ jobs }) => {
        if (cancelled) return;
        const registerJob = useBackgroundJobsStore.getState().registerJob;
        for (const j of jobs) {
          registerJob({
            jobId: j.jobId,
            kind: j.kind,
            title: j.title,
            startedAt: j.createdAt,
          });
        }
      })
      .catch(() => {
        /* non-fatal: tray stays empty until next action */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /* px-safe keeps the shell out of the landscape notch, which viewport-fit=cover would
     otherwise let it slide under. The bottom inset is handled by the stats bars and the
     drawer footer, so their own backgrounds paint the home-indicator strip. */
  return (
    <div className="flex h-dvh flex-col px-safe">
      <TopBar />

      <div className="flex flex-1 overflow-hidden">
        <LeftPanel />

        <main className="flex flex-1 flex-col overflow-hidden bg-surface">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
