import { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import TopBar from './TopBar';
import LeftPanel from './LeftPanel';
import { RECORD } from '../../store/records.js';
import { useRecord } from '../../hooks/useRecord.js';
import { useBackgroundJobsStore } from '../../store/backgroundJobsStore.js';

export default function AppLayout() {
  /* The settings are read while the app shell shows, so every view that shows them
   * finds them read. */
  const settings = useRecord(RECORD.SETTINGS).data;

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

  /* The jobs topic feeds the tray and every workload's busy state. */
  const connectJobs = useBackgroundJobsStore((s) => s.connect);
  const disconnectJobs = useBackgroundJobsStore((s) => s.disconnect);
  useEffect(() => {
    connectJobs();
    return disconnectJobs;
  }, [connectJobs, disconnectJobs]);

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
