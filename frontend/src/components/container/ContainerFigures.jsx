import { liveData } from '../../store/streamStore.js';
import { useContainerStatsStore } from '../../store/containerStore.js';
import { formatDecimal, formatLanIpHost, formatMemory, formatUptimeMs } from '../../utils/formatters.js';
import ErrorBanner from '../shared/ErrorBanner.jsx';
import FiguresRow from '../shared/FiguresRow.jsx';

const RUNNING = new Set(['running', 'paused', 'pausing']);

/**
 * The running container's figures, as its stats stream carries them: address, local
 * name, uptime, CPU and memory. The address and local name are the stream's alone: both
 * are assigned after the start, so the config read when the page opened has neither. A
 * stats read that failed shows its error in their place until the next good frame.
 */
export default function ContainerFigures({ state }) {
  const stats = useContainerStatsStore(liveData);
  const error = useContainerStatsStore((s) => s.error);
  if (error) return <ErrorBanner error={error} prefix="Figures unavailable" />;
  if (!RUNNING.has(state)) return <FiguresRow stoppedText={state === 'stopped' ? 'Stopped' : `State: ${state ?? 'unknown'}`} />;

  const used = stats?.memoryUsageMiB ?? null;
  const limit = stats?.memoryLimitMiB || null;
  return (
    <FiguresRow
      facts={[
        { label: 'Address', value: stats?.ip ? formatLanIpHost(stats.ip) : '—', mono: true },
        { label: 'Local name', value: stats?.mdnsHostname || '—', mono: true },
        { label: 'Uptime', value: state === 'paused' ? 'Paused' : formatUptimeMs(stats?.uptime) },
      ]}
      meters={[
        { label: 'CPU', value: stats ? `${formatDecimal(stats.cpuPercent)}%` : '—', percent: stats?.cpuPercent ?? null },
        {
          label: 'Memory',
          value: used == null ? '—' : (limit ? `${formatMemory(used)} / ${formatMemory(limit)}` : formatMemory(used)),
          percent: used != null && limit ? (used / limit) * 100 : null,
        },
      ]}
    />
  );
}
