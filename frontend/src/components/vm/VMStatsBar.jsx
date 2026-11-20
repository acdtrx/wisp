import { useVmStore, useVmStatsStore } from '../../store/vmStore.js';
import StatPill from '../shared/StatPill.jsx';
import { formatDecimal, formatUptimeMs } from '../../utils/formatters.js';
import { liveData } from '../../store/streamStore.js';

export default function VMStatsBar() {
  /* Live stats only: none while the stream is down or its gather failed. */
  const vmStats = useVmStatsStore(liveData);
  const vmConfig = useVmStore((s) => s.config);

  if (!vmConfig) return null;

  const state = vmStats?.state || vmConfig?.state;
  const isActive = vmStats?.active;

  if (!isActive) {
    return (
      <div className="border-t border-surface-border bg-surface-card pb-safe">
        <div className="flex h-11 items-center px-4">
          <span className="text-xs text-text-muted">
            {state === 'paused' || state === 'pmsuspended' ? 'Paused' : 'Stopped'}
          </span>
        </div>
      </div>
    );
  }

  /* pb-safe on the wrapper, not the scroll row: the card background then fills the iOS
     home-indicator strip while the pills sit above the system gesture band, where a
     horizontal swipe scrolls them instead of reaching the app switcher. */
  return (
    <div className="border-t border-surface-border bg-surface-card pb-safe">
      <div className="flex h-11 items-center gap-2 px-4 overflow-x-auto">
        <StatPill
          label="vCPU"
          percent={vmStats.cpu?.percent ?? 0}
          value={`${formatDecimal(vmStats.cpu?.percent)}%`}
        />
        <StatPill
          label="Disk"
          value={`↑${formatDecimal(vmStats.disk?.readMBs)}  ↓${formatDecimal(vmStats.disk?.writeMBs)} MB/s`}
        />
        <StatPill
          label="Net"
          value={`↑${formatDecimal(vmStats.net?.txMBs)}  ↓${formatDecimal(vmStats.net?.rxMBs)} MB/s`}
        />
        <StatPill
          label="Uptime"
          value={formatUptimeMs(vmStats.uptime)}
        />
        {vmStats.guestHostname ? (
          <StatPill label="Host" value={vmStats.guestHostname} />
        ) : null}
        {vmStats.guestIp ? (
          <StatPill label="IP" value={vmStats.guestIp} />
        ) : null}
        {vmStats.guestAgent ? (
          <StatPill
            label="Agent"
            value={vmStats.guestAgent.connected ? 'connected' : 'disconnected'}
          />
        ) : null}
      </div>
    </div>
  );
}
