import { useEffect } from 'react';
import { Box, Monitor } from 'lucide-react';
import { useStatsStore } from '../../store/statsStore.js';
import StatPill from '../shared/StatPill.jsx';
import { formatDecimal } from '../../utils/formatters.js';

export default function HostStatsBar({ embedded = false }) {
  const { stats, connected, connect, disconnect } = useStatsStore();

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  if (!stats) {
    const loader = (
      <span className="text-xs text-text-muted whitespace-nowrap">
        {connected ? 'Loading stats…' : 'Connecting…'}
      </span>
    );
    if (embedded) {
      return <div className="flex items-center">{loader}</div>;
    }
    return (
      <div className="flex h-11 items-center border-b border-surface-border bg-surface-card px-4">
        {loader}
      </div>
    );
  }

  const pills = (
    <>
      <StatPill
        label="CPU"
        value={`${stats.cpu.allocated}/${stats.cpu.total} cores`}
        percent={stats.cpu.usagePercent}
      />
      <StatPill
        label="RAM"
        value={`${formatDecimal(stats.memory.allocatedGB)}/${formatDecimal(stats.memory.totalGB)} GB`}
        percent={stats.memory.usagePercent}
      />
      <StatPill
        label="Disk"
        value={`↑${formatDecimal(stats.disk.readMBs)}  ↓${formatDecimal(stats.disk.writeMBs)} MB/s`}
      />
      <StatPill
        label="Net"
        value={`↑${formatDecimal(stats.net.txMBs)}  ↓${formatDecimal(stats.net.rxMBs)} MB/s`}
      />
      <div className="flex items-center gap-2 rounded-md bg-surface px-3 py-1.5 border border-surface-border">
        <span className="text-[11px] font-medium uppercase tracking-wide text-text-muted whitespace-nowrap">Running</span>
        <Monitor className="h-3 w-3 shrink-0 text-text-secondary" aria-hidden />
        <span className="text-xs font-semibold text-text-primary">{stats.runningVMs}</span>
        <span className="text-xs font-normal text-text-muted">|</span>
        <Box className="h-3 w-3 shrink-0 text-text-secondary" aria-hidden />
        <span className="text-xs font-semibold text-text-primary">{stats.runningContainers ?? 0}</span>
      </div>
    </>
  );

  if (embedded) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center gap-2 overflow-x-auto">
        {pills}
      </div>
    );
  }

  return (
    <div className="flex h-11 items-center gap-2 border-b border-surface-border bg-surface-card px-4 overflow-x-auto">
      {pills}
    </div>
  );
}
