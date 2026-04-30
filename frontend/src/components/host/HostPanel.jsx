import { useState } from 'react';
import { useParams, useNavigate, Navigate } from 'react-router-dom';
import { Server, Power, RotateCcw, Loader2 } from 'lucide-react';
import { useStatsStore } from '../../store/statsStore.js';
import ConfirmDialog from '../shared/ConfirmDialog.jsx';
import HostOverview from './HostOverview.jsx';
import HostMgmt from './HostMgmt.jsx';
import AppConfig from './AppConfig.jsx';
import Software from './Software.jsx';
import BackupsPanel from '../backups/BackupsPanel.jsx';
import { hostShutdown, hostReboot } from '../../api/host.js';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'host-mgmt', label: 'Host Mgmt' },
  { id: 'software', label: 'Software' },
  { id: 'backups', label: 'Backups' },
  { id: 'app-config', label: 'App Config' },
];

const VALID_TAB_IDS = new Set(TABS.map((t) => t.id));

function TabButton({ id, label, active, hasBadge, onClick }) {
  return (
    <button
      type="button"
      onClick={() => onClick(id)}
      className={`relative border-b-2 px-3 py-2 text-sm font-medium transition-colors duration-150 ${
        active ? 'border-accent text-accent font-semibold' : 'border-transparent text-text-muted hover:text-text-primary'
      }`}
    >
      {label}
      {hasBadge && (
        <span className="absolute -top-0.5 -right-0.5 flex h-2 w-2 rounded-full bg-amber-500" title="Updates available" />
      )}
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
    return <Navigate to="/host/overview" replace />;
  }

  const handleTabChange = (id) => navigate(`/host/${id}`);

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
      <div className="flex h-11 flex-shrink-0 items-center justify-between gap-4 border-b border-surface-border bg-surface-card px-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex-shrink-0 rounded-lg p-1 text-text-secondary" aria-hidden>
            <Server size={18} />
          </div>
          <span className="truncate text-sm font-semibold text-text-primary">Host</span>
          <div className="flex border-l border-surface-border pl-3">
            {TABS.map(({ id, label }) => (
              <TabButton
                key={id}
                id={id}
                label={label}
                active={tab === id}
                hasBadge={id === 'software' && (pendingUpdates > 0 || wispUpdateAvailable)}
                onClick={handleTabChange}
              />
            ))}
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setPowerOffOpen(true)}
            disabled={!!powerLoading}
            className="flex items-center gap-1.5 rounded-md border border-surface-border px-2.5 py-1 text-sm font-medium text-text-secondary hover:bg-surface hover:text-text-primary transition-colors duration-150 disabled:opacity-40"
            title="Power Off"
          >
            {powerLoading === 'shutdown' ? <Loader2 size={18} className="animate-spin" /> : <Power size={18} />}
            Power Off
          </button>
          <button
            type="button"
            onClick={() => setRestartOpen(true)}
            disabled={!!powerLoading}
            className="relative flex items-center gap-1.5 rounded-md border border-surface-border px-2.5 py-1 text-sm font-medium text-text-secondary hover:bg-surface hover:text-text-primary transition-colors duration-150 disabled:opacity-40"
            title={rebootRequired ? `Restart (reboot required: ${rebootReasons.join(', ') || 'kernel update'})` : 'Restart'}
          >
            {powerLoading === 'restart' ? <Loader2 size={18} className="animate-spin" /> : <RotateCcw size={18} />}
            Restart
            {rebootRequired && (
              <span className="absolute -top-0.5 -right-0.5 flex h-2 w-2 rounded-full bg-amber-500" />
            )}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden flex flex-col">
        {tab === 'overview' && <HostOverview />}
        {tab === 'host-mgmt' && <HostMgmt />}
        {tab === 'software' && <Software />}
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
