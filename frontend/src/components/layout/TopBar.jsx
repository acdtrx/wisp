import { Wind } from 'lucide-react';
import { useSettingsStore } from '../../store/settingsStore.js';
import HostStatsBar from './HostStatsBar.jsx';
import BackgroundJobsIndicator from './BackgroundJobsIndicator.jsx';

export default function TopBar() {
  const serverName = useSettingsStore((s) => s.settings?.serverName ?? 'My Server');

  return (
    <header className="flex h-12 items-center justify-between gap-4 border-b border-surface-border bg-surface-card px-4">
      <div className="flex shrink-0 items-center gap-3">
        <Wind size={22} className="shrink-0 text-blue-500" strokeWidth={2} aria-hidden />
        <span className="text-base font-semibold text-text-primary tracking-tight">Wisp</span>
        <span className="text-sm text-text-muted">{serverName}</span>
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-3">
        <HostStatsBar embedded />
        <div className="flex shrink-0 items-center">
          <BackgroundJobsIndicator />
        </div>
      </div>
    </header>
  );
}
