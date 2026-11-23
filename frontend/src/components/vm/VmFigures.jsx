import { liveData } from '../../store/streamStore.js';
import { useVmStatsStore } from '../../store/vmStore.js';
import { formatDecimal, formatUptimeMs } from '../../utils/formatters.js';
import ErrorBanner from '../shared/ErrorBanner.jsx';
import FiguresRow from '../shared/FiguresRow.jsx';

const PAUSED = new Set(['paused', 'pmsuspended']);
const rate = (up, down) => `↑${formatDecimal(up)} ↓${formatDecimal(down)}`;

/**
 * The running VM's figures, as its stats stream carries them: address and host name
 * (from the guest agent, when it answers: left out until it does) and uptime, then CPU
 * and the disk and network rates, in MB/s. A stats read that failed shows its error in
 * their place until the next good frame.
 */
export default function VmFigures({ state }) {
  const stats = useVmStatsStore(liveData);
  const error = useVmStatsStore((s) => s.error);
  if (error) return <ErrorBanner error={error} prefix="Figures unavailable" />;
  if (!stats?.active) {
    const text = PAUSED.has(state) ? 'Paused' : state === 'shutoff' || state === 'nostate' ? 'Stopped' : `State: ${state ?? 'unknown'}`;
    return <FiguresRow stoppedText={text} />;
  }
  const uptime = formatUptimeMs(stats.uptime);
  return (
    <FiguresRow
      identity={[
        { label: 'Address', value: stats.guestIp, mono: true },
        { label: 'Host name', value: stats.guestHostname, name: true },
        { label: 'Uptime', value: uptime === '—' ? null : uptime, prefix: 'up' },
      ]}
      live={[
        { label: 'CPU', value: `${formatDecimal(stats.cpu?.percent)}%`, percent: stats.cpu?.percent ?? null, narrowMeter: true },
        { label: 'Disk', value: rate(stats.disk?.readMBs, stats.disk?.writeMBs) },
        { label: 'Net', value: rate(stats.net?.txMBs, stats.net?.rxMBs), unit: 'MB/s' },
      ]}
    />
  );
}
