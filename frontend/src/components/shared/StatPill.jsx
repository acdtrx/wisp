function getBarColor(percent) {
  if (percent >= 85) return 'bg-status-stopped';
  if (percent >= 60) return 'bg-status-warning';
  return 'bg-status-running';
}

export default function StatPill({ label, value, percent }) {
  const hasBar = percent != null;

  return (
    <div className="flex items-center gap-2 rounded-md bg-surface px-3 py-1.5 border border-surface-border">
      <span className="text-[11px] font-medium uppercase tracking-wide text-text-muted whitespace-nowrap">
        {label}
      </span>
      <span className="text-xs font-semibold text-text-primary whitespace-nowrap">{value}</span>
      {hasBar && (
        <div className="h-1.5 w-16 rounded-full bg-surface-border overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-300 ${getBarColor(percent)}`}
            style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
          />
        </div>
      )}
    </div>
  );
}
