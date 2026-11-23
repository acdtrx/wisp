import { liveData } from '../../store/streamStore.js';
import { useContainerStatsStore } from '../../store/containerStore.js';
import { formatDecimal, formatLanIpHost, formatMemory, formatMemoryOf, formatUptimeMs } from '../../utils/formatters.js';
import ErrorBanner from '../shared/ErrorBanner.jsx';
import FiguresRow from '../shared/FiguresRow.jsx';

const RUNNING = new Set(['running', 'paused', 'pausing']);

/**
 * The running container's figures, as its stats stream carries them: address, local
 * name and uptime, then CPU and memory. The address and local name are the stream's
 * alone: both are assigned after the start, so the config read when the page opened has
 * neither, and each is left out until the stream has it. A stats read that failed shows
 * its error in their place until the next good frame.
 */
export default function ContainerFigures({ state }) {
  const stats = useContainerStatsStore(liveData);
  const error = useContainerStatsStore((s) => s.error);
  if (error) return <ErrorBanner error={error} prefix="Figures unavailable" />;
  if (!RUNNING.has(state)) return <FiguresRow stoppedText={state === 'stopped' ? 'Stopped' : `State: ${state ?? 'unknown'}`} />;

  const used = stats?.memoryUsageMiB ?? null;
  const limit = stats?.memoryLimitMiB || null;
  /* "7 / 256 MB" is shown as "7 / 256" and a small "MB". */
  const memory = used == null ? null : /^(.*) (\S+)$/.exec(limit ? formatMemoryOf(used, limit) : formatMemory(used));
  const uptime = formatUptimeMs(stats?.uptime);
  return (
    <FiguresRow
      identity={[
        { label: 'Address', value: stats?.ip ? formatLanIpHost(stats.ip) : null, mono: true },
        { label: 'Local name', value: stats?.mdnsHostname || null, name: true },
        state === 'paused'
          ? { label: 'Uptime', value: 'paused' }
          : { label: 'Uptime', value: uptime === '—' ? null : uptime, prefix: 'up' },
      ]}
      live={[
        { label: 'CPU', value: stats ? `${formatDecimal(stats.cpuPercent)}%` : null, percent: stats?.cpuPercent ?? null },
        {
          label: 'Memory',
          value: memory?.[1] ?? null,
          unit: memory?.[2],
          percent: used != null && limit ? (used / limit) * 100 : null,
        },
      ]}
    />
  );
}
