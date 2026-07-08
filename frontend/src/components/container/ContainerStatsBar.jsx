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
      <div className="border-t border-surface-border bg-surface-card pb-safe">
        <div className="flex h-11 items-center px-4">
          <span className="text-xs text-text-muted">
            {state === 'paused' ? 'Paused' : 'Stopped'}
          </span>
        </div>
      </div>
    );
  }

  const memLimit = stats?.memoryLimitMiB || config?.memoryLimitMiB || 0;

  /* mDNS registration and the CNI-assigned IP both happen *after* the container starts,
     so `config` — a snapshot taken when the workload was selected — never shows them on a
     container the user just started. Once the stats stream has produced a real frame it is
     authoritative for both; config only seeds the paint before the first frame lands (and
     covers error frames, which carry no fields). */
  const live = stats && !stats.error ? stats : null;
  const ip = live ? live.ip : config.network?.ip;
  const mdnsHostname = live ? live.mdnsHostname : config.mdnsHostname;

  /* The pb-safe wrapper carries the border and background so the card colour fills the
     iOS home-indicator strip, while the scroll row it wraps stays clear of the system
     gesture band — inside it, a horizontal swipe reaches the app switcher, not the pills. */
  return (
    <div className="border-t border-surface-border bg-surface-card pb-safe">
      <div className="flex h-11 items-center gap-2 px-4 overflow-x-auto">
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
        {ip ? <StatPill label="IP" value={formatLanIpHost(ip)} /> : null}
        {mdnsHostname ? <StatPill label="mDNS" value={mdnsHostname} /> : null}
        {stats?.pid ? <StatPill label="PID" value={String(stats.pid)} /> : null}
      </div>
    </div>
  );
}
