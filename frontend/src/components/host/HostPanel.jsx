import { useState } from 'react';
import { useParams, useNavigate, Navigate } from 'react-router-dom';
import { Server, Power, RotateCcw, Loader2 } from 'lucide-react';
import { useStatsStore } from '../../store/statsStore.js';
import ConfirmDialog from '../shared/ConfirmDialog.jsx';
import HostOverview from './HostOverview.jsx';
import HostMgmt from './HostMgmt.jsx';
import AppConfig from './AppConfig.jsx';
import Software from './Software.jsx';
import HomePanel from '../home/HomePanel.jsx';
import BackupsPanel from '../backups/BackupsPanel.jsx';
import { hostShutdown, hostReboot } from '../../api/host.js';

const TABS = [
  { id: 'home', label: 'Home' },
  { id: 'overview', label: 'Overview' },
  { id: 'host-mgmt', label: 'Host Mgmt' },
  { id: 'software', label: 'Software' },
  { id: 'backups', label: 'Backups' },
  { id: 'app-config', label: 'App Config' },
];

const VALID_TAB_IDS = new Set(TABS.map((t) => t.id));

function TabButton({ id, label, active, badgeTitle, onClick }) {
  return (
    <button
      type="button"
      onClick={() => onClick(id)}
      className={`flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors duration-150 ${
        active ? 'border-accent text-accent-text font-semibold' : 'border-transparent text-text-muted hover:text-text-primary'
      }`}
    >
      {/* Dot before the label so a partially scrolled tab clips its text, not the badge. */}
      {badgeTitle && (
        <span
          className="flex h-2 w-2 shrink-0 rounded-full bg-status-warning"
          title={badgeTitle}
        />
      )}
      <span>{label}</span>
    </button>
  );
}

export default function HostPanel() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const stats = useStatsStore((s) => s.stats);
  const pendingUpdates = stats?.pendingUpdates ?? 0;
  const wispUpdateAvailable = !!stats?.wispUpdate?.available;
  const rebootRequired = !!stats?.rebootRequired;
  const rebootReasons = stats?.rebootReasons ?? [];

  const [powerOffOpen, setPowerOffOpen] = useState(false);
  const [restartOpen, setRestartOpen] = useState(false);
  const [powerLoading, setPowerLoading] = useState(null);

  if (!tab || !VALID_TAB_IDS.has(tab)) {
    return <Navigate to="/host/home" replace />;
  }

  const handleTabChange = (id) => navigate(`/host/${id}`);

  const softwareReasons = [];
  if (wispUpdateAvailable) softwareReasons.push('Wisp update available');
  if (pendingUpdates > 0) softwareReasons.push(`${pendingUpdates} OS package update(s)`);
  if (rebootRequired) {
    const detail = rebootReasons.length > 0
      ? `: ${rebootReasons.slice(0, 4).join(', ')}${rebootReasons.length > 4 ? `, +${rebootReasons.length - 4} more` : ''}`
      : '';
    softwareReasons.push(`Reboot required${detail}`);
  }
  const softwareBadgeTitle = softwareReasons.length > 0 ? softwareReasons.join(' · ') : null;

  const handlePowerOff = async () => {
    setPowerLoading('shutdown');
    try {
      await hostShutdown();
      setPowerOffOpen(false);
    } catch (err) {
      setPowerOffOpen(false);
    } finally {
      setPowerLoading(null);
    }
  };

  const handleRestart = async () => {
    setPowerLoading('restart');
    try {
      await hostReboot();
      setRestartOpen(false);
    } catch (err) {
      setRestartOpen(false);
    } finally {
      setPowerLoading(null);
    }
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Below lg: identity + square power buttons on the first row, the tab strip
        * full-width on a second row (mirrors the workload detail headers). At lg+
        * everything sits on the single 44px row as before. */}
      <div className="flex shrink-0 flex-wrap items-center border-b border-surface-border bg-surface-card px-4 lg:h-11 lg:flex-nowrap lg:gap-x-4">
        <div className="flex min-h-11 min-w-0 items-center gap-3 lg:min-h-0">
          <div className="relative shrink-0 rounded-lg p-1 text-text-secondary" aria-hidden>
            <Server size={18} />
            {/* First-view badge for phones, where the Software tab may sit scrolled
              * out of the strip. Desktop shows the whole strip, so the tab dot serves. */}
            {softwareBadgeTitle && (
              <span
                className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-status-warning lg:hidden"
                title={softwareBadgeTitle}
              />
            )}
          </div>
          <span className="truncate text-sm font-semibold text-text-primary">Host</span>
        </div>
        <div className="order-3 -mx-4 flex w-[calc(100%+2rem)] overflow-x-auto border-t border-surface-border px-2 lg:order-none lg:mx-0 lg:w-auto lg:min-w-0 lg:flex-1 lg:border-t-0 lg:border-l lg:px-0 lg:pl-3">
          {TABS.map(({ id, label }) => (
            <TabButton
              key={id}
              id={id}
              label={label}
              active={tab === id}
              badgeTitle={id === 'software' ? softwareBadgeTitle : null}
              onClick={handleTabChange}
            />
          ))}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setPowerOffOpen(true)}
            disabled={!!powerLoading}
            className="flex items-center justify-center gap-1.5 rounded-md border border-surface-border p-2 text-sm font-medium text-text-secondary hover:bg-surface hover:text-text-primary transition-colors duration-150 disabled:opacity-40 lg:px-2.5 lg:py-1"
            title="Power Off"
            aria-label="Power Off"
          >
            {powerLoading === 'shutdown' ? <Loader2 size={18} className="animate-spin" /> : <Power size={18} />}
            <span className="hidden lg:inline">Power Off</span>
          </button>
          <button
            type="button"
            onClick={() => setRestartOpen(true)}
            disabled={!!powerLoading}
            className="relative flex items-center justify-center gap-1.5 rounded-md border border-surface-border p-2 text-sm font-medium text-text-secondary hover:bg-surface hover:text-text-primary transition-colors duration-150 disabled:opacity-40 lg:px-2.5 lg:py-1"
            title={rebootRequired ? `Restart (reboot required: ${rebootReasons.join(', ') || 'kernel update'})` : 'Restart'}
            aria-label="Restart"
          >
            {powerLoading === 'restart' ? <Loader2 size={18} className="animate-spin" /> : <RotateCcw size={18} />}
            <span className="hidden lg:inline">Restart</span>
            {rebootRequired && (
              <span className="absolute -top-0.5 -right-0.5 flex h-2 w-2 rounded-full bg-status-warning" />
            )}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden flex flex-col">
        {tab === 'home' && <HomePanel />}
        {tab === 'overview' && <HostOverview />}
        {tab === 'host-mgmt' && <HostMgmt />}
        {tab === 'software' && <Software onRequestRestart={() => setRestartOpen(true)} />}
        {tab === 'backups' && <BackupsPanel />}
        {tab === 'app-config' && <AppConfig />}
      </div>

      <ConfirmDialog
        open={powerOffOpen}
        title="Power off host?"
        message="The server will shut down. You will need physical or out-of-band access to turn it back on."
        confirmLabel="Power Off"
        onConfirm={handlePowerOff}
        onCancel={() => setPowerOffOpen(false)}
      />
      <ConfirmDialog
        open={restartOpen}
        title="Restart host?"
        message={
          rebootRequired
            ? `A reboot is pending${rebootReasons.length > 0 ? ` (${rebootReasons.slice(0, 4).join(', ')}${rebootReasons.length > 4 ? `, +${rebootReasons.length - 4} more` : ''})` : ''}. The server will reboot. This may take a minute. You will be disconnected.`
            : 'The server will reboot. This may take a minute. You will be disconnected.'
        }
        confirmLabel="Restart"
        onConfirm={handleRestart}
        onCancel={() => setRestartOpen(false)}
      />
    </div>
  );
}
