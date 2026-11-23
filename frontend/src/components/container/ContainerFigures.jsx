import { liveData } from '../../store/streamStore.js';
import { useContainerStatsStore } from '../../store/containerStore.js';
import { formatDecimal, formatLanIpHost, formatMemory, formatMemoryOf, formatUptimeMs } from '../../utils/formatters.js';
import ErrorBanner from '../shared/ErrorBanner.jsx';
import FiguresRow, { PERCENT_SLOT } from '../shared/FiguresRow.jsx';

/** What formatMemoryOf usually writes at its widest: a limit set in MB ("255 / 256 MB"). A limit in GB writes wider ("512 MB / 2 GB") and grows the slot. */
const MEMORY_SLOT = '999 / 999 MB';

/**
 * The container's figures, by its state: running, its stats stream's figures as far as
 * the stream has them (none before its first frame): address, local name and uptime,
 * then CPU and memory, a meter beside memory only when it has a limit. The address and
 * local name are the stream's alone: both are assigned after the start, so the config
 * read when the page opened has neither, and each is left out until the stream has it.
 * Paused or stopped, the row says so; another state, its word. A stats read that failed
 * shows its error in their place until the next good frame.
 */
export default function ContainerFigures({ state }) {
  const stats = useContainerStatsStore(liveData);
  const error = useContainerStatsStore((s) => s.error);
  if (error) return <ErrorBanner error={error} prefix="Figures unavailable" />;
  if (state === 'paused') return <FiguresRow stoppedText="Paused" />;
  if (state === 'stopped') return <FiguresRow stoppedText="Stopped" />;
  if (state !== 'running') return <FiguresRow stoppedText={`State: ${state ?? 'unknown'}`} />;
  if (!stats) return <FiguresRow />;

  const used = stats.memoryUsageMiB ?? null;
  const limit = stats.memoryLimitMiB || null;
  const uptime = formatUptimeMs(stats.uptime);
  return (
    <FiguresRow
      identity={[
        { label: 'Address', value: stats.ip ? formatLanIpHost(stats.ip) : null, mono: true },
        { label: 'Local name', value: stats.mdnsHostname || null },
        { label: 'Uptime', value: uptime === '—' ? null : uptime, prefix: 'up', keep: true },
      ]}
      live={[
        { label: 'CPU', value: `${formatDecimal(stats.cpuPercent)}%`, slot: PERCENT_SLOT, percent: stats.cpuPercent ?? null },
        {
          label: 'Memory',
          value: used == null ? null : limit ? formatMemoryOf(used, limit) : formatMemory(used),
          slot: MEMORY_SLOT,
          percent: used != null && limit ? (used / limit) * 100 : null,
        },
      ]}
    />
  );
}
