import { useNavigate } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import { useAuthStore } from '../../store/authStore.js';
import HostStatsBar from './HostStatsBar.jsx';
import BackgroundJobsIndicator from './BackgroundJobsIndicator.jsx';
import ServerSwitcher from './ServerSwitcher.jsx';
import WispGlyph from '../shared/WispGlyph.jsx';

export default function TopBar() {
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <header className="flex h-12 items-center justify-between gap-4 border-b border-surface-border bg-surface-card px-4">
      <div className="flex shrink-0 items-center gap-3">
        <WispGlyph size={22} className="shrink-0" />
        <span className="font-display text-base font-semibold text-text-primary tracking-tight">Wisp</span>
        <ServerSwitcher />
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-3">
        <HostStatsBar embedded />
        <div className="flex shrink-0 items-center gap-1.5">
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
      </div>
    </header>
  );
}
