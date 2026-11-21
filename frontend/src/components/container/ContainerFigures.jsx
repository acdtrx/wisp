import { liveData } from '../../store/streamStore.js';
import { useContainerStatsStore } from '../../store/containerStore.js';
import { formatDecimal, formatLanIpHost, formatUptimeMs } from '../../utils/formatters.js';
import FiguresRow from '../shared/FiguresRow.jsx';

const RUNNING = new Set(['running', 'paused', 'pausing']);

/**
 * The running container's figures, as its stats stream carries them: address, local
 * name, uptime, CPU and memory. The address and local name are the stream's alone: both
 * are assigned after the start, so the config read when the page opened has neither.
 */
export default function ContainerFigures({ state }) {
  const stats = useContainerStatsStore(liveData);
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
          value: used == null ? '—' : (limit ? `${used} / ${limit} MiB` : `${used} MiB`),
          percent: used != null && limit ? (used / limit) * 100 : null,
        },
      ]}
    />
  );
}
