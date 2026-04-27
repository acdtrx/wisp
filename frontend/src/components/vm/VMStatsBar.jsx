import { useVmStore } from '../../store/vmStore.js';
import StatPill from '../shared/StatPill.jsx';
import { formatDecimal, formatUptimeMs } from '../../utils/formatters.js';

export default function VMStatsBar() {
  const vmStats = useVmStore((s) => s.vmStats);
  const vmConfig = useVmStore((s) => s.vmConfig);

  if (!vmConfig) return null;

  const state = vmStats?.state || vmConfig?.state;
  const isActive = vmStats?.active;

  if (!isActive) {
    return (
      <div className="flex h-11 items-center border-t border-surface-border bg-surface-card px-4">
        <span className="text-xs text-text-muted">
          {state === 'paused' || state === 'pmsuspended' ? 'Paused' : 'Stopped'}
        </span>
      </div>
    );
  }

  return (
    <div className="flex h-11 items-center gap-2 border-t border-surface-border bg-surface-card px-4 overflow-x-auto">
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
      {vmStats.mdnsHostname ? (
        <StatPill label="mDNS" value={vmStats.mdnsHostname} />
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
  );
}
