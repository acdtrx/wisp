import { useState } from 'react';
import { useParams, Navigate } from 'react-router-dom';
import { Server, Power, RotateCcw } from 'lucide-react';

import { useStatsStore } from '../../store/statsStore.js';
import AlertDialog from '../shared/AlertDialog.jsx';
import ConfirmDialog from '../shared/ConfirmDialog.jsx';
import HostOverview from './HostOverview.jsx';
import HostMgmt from './HostMgmt.jsx';
import AppConfig from './AppConfig.jsx';
import Software from './Software.jsx';
import HomePanel from '../home/HomePanel.jsx';
import BackupsPanel from '../backups/BackupsPanel.jsx';
import { hostShutdown, hostReboot } from '../../api/host.js';
import { errorText } from '../../api/errors.js';
import { useCommand } from '../../hooks/useCommand.js';
import Button from '../shared/Button.jsx';
import Tab from '../shared/Tab.jsx';

const TABS = [
  { id: 'home', label: 'Home' },
  { id: 'overview', label: 'Overview' },
  { id: 'host-mgmt', label: 'Host Mgmt' },
  { id: 'software', label: 'Software' },
  { id: 'backups', label: 'Backups' },
  { id: 'app-config', label: 'App Config' },
];

const VALID_TAB_IDS = new Set(TABS.map((t) => t.id));


export default function HostPanel() {
  const { tab } = useParams();
  const stats = useStatsStore((s) => s.data);
  const pendingUpdates = stats?.pendingUpdates ?? 0;
  const wispUpdateAvailable = !!stats?.wispUpdate?.available;
  const rebootRequired = !!stats?.rebootRequired;
  const rebootReasons = stats?.rebootReasons ?? [];

  const [powerOffOpen, setPowerOffOpen] = useState(false);
  const [restartOpen, setRestartOpen] = useState(false);
  /* Power off and restart, keyed by which: the host takes one, so both buttons are
   * disabled while either runs. A failure shows in an alert, titled by which failed. */
  const power = useCommand();
  const powerLoading = power.running[0] ?? null;
  const failedPower = power.errors[0] ?? null;

  if (!tab || !VALID_TAB_IDS.has(tab)) {
    return <Navigate to="/host/home" replace />;
  }

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

  /* The confirm closes at once; the button shows the command in flight. */
  const runPower = (key, send, closeConfirm) => {
    closeConfirm(false);
    power.run(send, { key });
  };
  const handlePowerOff = () => runPower('shutdown', hostShutdown, setPowerOffOpen);
  const handleRestart = () => runPower('restart', hostReboot, setRestartOpen);

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
            <Tab
              key={id}
              to={`/host/${id}`}
              active={tab === id}
              dot={id === 'software' && !!softwareBadgeTitle}
              dotTitle={softwareBadgeTitle}
            >
              {label}
            </Tab>
          ))}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button labelFrom="lg" icon={Power} busy={powerLoading === 'shutdown'} disabled={!!powerLoading} title="Power Off" onClick={() => setPowerOffOpen(true)}>
            Power Off
          </Button>
          <Button
            labelFrom="lg"
            icon={RotateCcw}
            busy={powerLoading === 'restart'}
            disabled={!!powerLoading}
            title={rebootRequired ? `Restart (reboot required: ${rebootReasons.join(', ') || 'kernel update'})` : 'Restart'}
            badge={rebootRequired && <span className="absolute -top-0.5 -right-0.5 flex h-2 w-2 rounded-full bg-status-warning" />}
            onClick={() => setRestartOpen(true)}
          >
            Restart
          </Button>
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
      <AlertDialog
        open={!!failedPower}
        title={failedPower?.key === 'shutdown' ? 'Power off failed' : 'Restart failed'}
        message={failedPower ? errorText(failedPower.error) : ''}
        tone="error"
        onClose={() => power.dismiss(failedPower?.key)}
      />
    </div>
  );
}
