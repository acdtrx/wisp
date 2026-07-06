import { useNavigate } from 'react-router-dom';
import { LogOut, Menu, X } from 'lucide-react';
import { useAuthStore } from '../../store/authStore.js';
import { useUiStore } from '../../store/uiStore.js';
import HostStatsBar from './HostStatsBar.jsx';
import BackgroundJobsIndicator from './BackgroundJobsIndicator.jsx';
import ServerSwitcher from './ServerSwitcher.jsx';
import WispGlyph from '../shared/WispGlyph.jsx';

export default function TopBar() {
  const logout = useAuthStore((s) => s.logout);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    /* Grid so the single HostStatsBar instance (it owns the stats SSE
       subscription) moves to its own full-width second row below lg
       instead of being squeezed between the topbar clusters. */
    <header className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 border-b border-surface-border bg-surface-card px-4">
      <div className="flex h-12 shrink-0 items-center gap-3">
        <button
          type="button"
          onClick={toggleSidebar}
          className="flex items-center justify-center rounded-md border border-surface-border p-2 text-text-secondary hover:bg-surface hover:text-text-primary transition-colors duration-150 lg:hidden"
          title={sidebarOpen ? 'Close workload list' : 'Open workload list'}
          aria-label={sidebarOpen ? 'Close workload list' : 'Open workload list'}
          aria-expanded={sidebarOpen}
        >
          {sidebarOpen ? <X size={18} aria-hidden /> : <Menu size={18} aria-hidden />}
        </button>
        <WispGlyph size={22} className="shrink-0" />
        <span className="font-display text-base font-semibold text-text-primary tracking-tight">Wisp</span>
        <ServerSwitcher />
      </div>

      <div className="col-span-3 row-start-2 flex min-w-0 items-center pb-2 lg:col-span-1 lg:col-start-2 lg:row-start-1 lg:pb-0">
        <HostStatsBar embedded />
      </div>

      <div className="col-start-3 row-start-1 flex shrink-0 items-center gap-1.5">
        <BackgroundJobsIndicator />
        <button
          type="button"
          onClick={handleLogout}
          className="flex items-center justify-center rounded-md border border-surface-border p-1.5 text-text-secondary hover:bg-surface hover:text-text-primary transition-colors duration-150"
          title="Sign out"
          aria-label="Sign out"
        >
          <LogOut size={18} aria-hidden />
        </button>
      </div>
    </header>
  );
}
