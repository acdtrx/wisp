import { liveData } from '../../store/streamStore.js';
import { useVmStatsStore } from '../../store/vmStore.js';
import { formatDecimal, formatUptimeMs } from '../../utils/formatters.js';
import FiguresRow from '../shared/FiguresRow.jsx';

const PAUSED = new Set(['paused', 'pmsuspended']);
const rate = (up, down) => `↑${formatDecimal(up)} ↓${formatDecimal(down)} MB/s`;

/**
 * The running VM's figures, as its stats stream carries them: address and host name
 * (from the guest agent, when it answers), uptime, CPU, disk and network rates.
 */
export default function VmFigures({ state }) {
  const stats = useVmStatsStore(liveData);
  if (!stats?.active) {
    const text = PAUSED.has(state) ? 'Paused' : state === 'shutoff' || state === 'nostate' ? 'Stopped' : `State: ${state ?? 'unknown'}`;
    return <FiguresRow stoppedText={text} />;
  }
  return (
    <FiguresRow
      facts={[
        { label: 'Address', value: stats.guestIp || '—', mono: true },
        { label: 'Host name', value: stats.guestHostname || '—', mono: true },
        { label: 'Uptime', value: formatUptimeMs(stats.uptime) },
      ]}
      meters={[
        { label: 'CPU', value: `${formatDecimal(stats.cpu?.percent)}%`, percent: stats.cpu?.percent ?? null },
        { label: 'Disk', value: rate(stats.disk?.readMBs, stats.disk?.writeMBs) },
        { label: 'Network', value: rate(stats.net?.txMBs, stats.net?.rxMBs) },
      ]}
    />
  );
}
