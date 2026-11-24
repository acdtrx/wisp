import { liveData } from '../../store/streamStore.js';
import { useVmStatsStore } from '../../store/vmStore.js';
import { formatDecimal, formatUptimeMs } from '../../utils/formatters.js';
import ErrorBanner from '../shared/ErrorBanner.jsx';
import FiguresRow, { PERCENT_SLOT } from '../shared/FiguresRow.jsx';

const PAUSED = new Set(['paused', 'pmsuspended']);
const STOPPED = new Set(['shutoff', 'nostate']);

/**
 * Two rates in MB/s under their arrows, which a screen reader does not say: it hears
 * each rate's word and unit instead (`words`, what the up and the down arrow mean).
 */
function Rate({ up, down, words }) {
  return (
    <>
      <span className="sr-only">{words[0]} </span>
      <span aria-hidden>↑</span>
      {formatDecimal(up)}
      <span className="sr-only"> MB/s,</span>{' '}
      <span className="sr-only">{words[1]} </span>
      <span aria-hidden>↓</span>
      {formatDecimal(down)}
      <span className="sr-only"> MB/s</span>
    </>
  );
}

/** A rate's usual range, up to 99.9 MB/s each way, set as a rate is (each piece shaped alone). */
function RateSlot() {
  return <Rate up={99.9} down={99.9} words={['', '']} />;
}

/**
 * A phone's shorter form of two rates: their sum, one number in MB/s, its unit said to a
 * screen reader. A direction the stream lacks counts as 0.0, as a single rate shows it.
 */
function phoneRate(up, down) {
  return {
    value: (
      <>
        {formatDecimal((up ?? 0) + (down ?? 0))}
        <span className="sr-only"> MB/s</span>
      </>
    ),
    slot: '99.9',
  };
}

/**
 * The VM's figures, by its state: paused or stopped, the row says so; running, its
 * stats stream's figures as far as the stream has them (none before its first frame);
 * another state, its figures while the stream has them, else the state's word:
 * address and host name (from the guest agent, when it answers: left out until it
 * does) and uptime, then CPU and the disk and network rates: each way under its arrow,
 * and on a phone, whose one line holds no more, both ways summed into one number. A
 * stats read that failed shows its error in their place until the next good frame.
 */
export default function VmFigures({ state }) {
  const stats = useVmStatsStore(liveData);
  const error = useVmStatsStore((s) => s.error);
  if (error) return <ErrorBanner error={error} prefix="Figures unavailable" />;
  if (PAUSED.has(state)) return <FiguresRow stoppedText="Paused" />;
  if (STOPPED.has(state)) return <FiguresRow stoppedText="Stopped" />;
  if (!stats?.active) return state === 'running' ? <FiguresRow /> : <FiguresRow stoppedText={`State: ${state ?? 'unknown'}`} />;
  const uptime = formatUptimeMs(stats.uptime);
  return (
    <FiguresRow
      identity={[
        { label: 'Address', value: stats.guestIp, mono: true },
        { label: 'Host name', value: stats.guestHostname },
        { label: 'Uptime', value: uptime === '—' ? null : uptime, prefix: 'up', keep: true },
      ]}
      live={[
        { label: 'CPU', value: `${formatDecimal(stats.cpu?.percent)}%`, slot: PERCENT_SLOT, percent: stats.cpu?.percent ?? null },
        {
          label: 'Disk',
          value: <Rate up={stats.disk?.readMBs} down={stats.disk?.writeMBs} words={['read', 'write']} />,
          slot: <RateSlot />,
          phone: phoneRate(stats.disk?.readMBs, stats.disk?.writeMBs),
        },
        {
          label: 'Net',
          value: <Rate up={stats.net?.txMBs} down={stats.net?.rxMBs} words={['sent', 'received']} />,
          slot: <RateSlot />,
          phone: phoneRate(stats.net?.txMBs, stats.net?.rxMBs),
          unit: <span aria-hidden>MB/s</span>,
        },
      ]}
    />
  );
}
