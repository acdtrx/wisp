import { useContainerStore } from '../../store/containerStore.js';
import StatPill from '../shared/StatPill.jsx';
import { formatDecimal, formatUptimeMs, formatLanIpHost } from '../../utils/formatters.js';

export default function ContainerStatsBar() {
  const stats = useContainerStore((s) => s.containerStats);
  const config = useContainerStore((s) => s.containerConfig);

  if (!config) return null;

  const state = stats?.state || config?.state;
  const isRunning = state === 'running';

  if (!isRunning) {
    return (
      <div className="flex h-11 items-center border-t border-surface-border bg-surface-card px-4">
        <span className="text-xs text-text-muted">
          {state === 'paused' ? 'Paused' : 'Stopped'}
        </span>
      </div>
    );
  }

  const memLimit = stats?.memoryLimitMiB || config?.memoryLimitMiB || 0;

  return (
    <div className="flex h-11 items-center gap-2 border-t border-surface-border bg-surface-card px-4 overflow-x-auto">
      <StatPill
        label="CPU"
        percent={stats?.cpuPercent ?? 0}
        value={`${formatDecimal(stats?.cpuPercent)}%`}
      />
      <StatPill
        label="Memory"
        value={`${stats?.memoryUsageMiB ?? 0} MiB${memLimit ? ` / ${memLimit} MiB` : ''}`}
      />
      <StatPill
        label="Uptime"
        value={formatUptimeMs(stats?.uptime)}
      />
      {config.network?.ip ? (
        <StatPill label="IP" value={formatLanIpHost(config.network.ip)} />
      ) : null}
      {config.mdnsHostname ? (
        <StatPill label="mDNS" value={config.mdnsHostname} />
      ) : null}
      {stats?.pid ? <StatPill label="PID" value={String(stats.pid)} /> : null}
    </div>
  );
}
