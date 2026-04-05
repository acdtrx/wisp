import { useState, useRef, useEffect } from 'react';
import { ListTodo } from 'lucide-react';
import { useBackgroundJobsStore } from '../../store/backgroundJobsStore.js';

function formatStep(row) {
  if (row.status === 'done') return 'Done';
  if (row.status === 'error') return row.error || 'Error';
  if (row.step) return String(row.step);
  return 'Starting…';
}

/** Rounded track + fill; use when we have a numeric percent or a terminal success state. */
function JobProgressBar({ percent, status }) {
  const p =
    status === 'done'
      ? 100
      : typeof percent === 'number' && !Number.isNaN(percent)
        ? Math.min(100, Math.max(0, percent))
        : null;
  if (p == null) return null;

  const isDone = status === 'done';

  return (
    <div
      className="mt-2 overflow-hidden rounded-full bg-surface-border/90 p-[2px] shadow-[inset_0_1px_2px_rgba(15,23,42,0.06)]"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(p)}
    >
      <div className="h-2 overflow-hidden rounded-full bg-surface/80">
        <div
          className={`h-full rounded-full transition-[width] duration-500 ease-out ${
            isDone
              ? 'bg-gradient-to-r from-emerald-500 to-teal-600 shadow-sm'
              : 'bg-gradient-to-r from-accent via-blue-500 to-indigo-500 shadow-[0_1px_2px_rgba(37,99,235,0.35)]'
          }`}
          style={{ width: `${p}%` }}
        />
      </div>
    </div>
  );
}

export default function BackgroundJobsIndicator() {
  const jobs = useBackgroundJobsStore((s) => s.jobs);
  const dismissJob = useBackgroundJobsStore((s) => s.dismissJob);
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  const list = Object.values(jobs).sort((a, b) => b.startedAt - a.startedAt);
  const running = list.filter((j) => j.status === 'running').length;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  if (list.length === 0) return null;

  return (
    <div className="relative shrink-0" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="relative flex items-center justify-center rounded-md border border-surface-border p-1.5 text-text-secondary hover:bg-surface hover:text-text-primary transition-colors duration-150"
        title="Background jobs"
        aria-label="Background jobs"
        aria-expanded={open}
      >
        <ListTodo size={18} aria-hidden />
        {running > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-white">
            {running > 9 ? '9+' : running}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-[min(100vw-2rem,22rem)] rounded-lg border border-surface-border bg-surface-card py-1 shadow-lg">
          <div className="border-b border-surface-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            Background jobs
          </div>
          <ul className="max-h-72 overflow-y-auto">
            {list.map((row) => (
              <li
                key={row.jobId}
                className="border-b border-surface-border px-3 py-2.5 last:border-0"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-text-primary">{row.title}</p>
                    <p className="mt-0.5 text-xs text-text-secondary">
                      {formatStep(row)}
                      {row.percent != null && row.status === 'running' && (
                        <span className="ml-1.5 tabular-nums font-mono text-text-muted">{Math.round(row.percent)}%</span>
                      )}
                    </p>
                    {(row.status === 'running' && row.percent != null) || row.status === 'done' ? (
                      <JobProgressBar percent={row.percent} status={row.status} />
                    ) : null}
                    {row.detail && row.status === 'running' && (
                      <p className="mt-1.5 truncate font-mono text-[11px] text-text-muted">{row.detail}</p>
                    )}
                  </div>
                  {row.status !== 'running' && (
                    <button
                      type="button"
                      onClick={() => dismissJob(row.jobId)}
                      className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-text-muted hover:bg-surface hover:text-text-secondary"
                    >
                      Dismiss
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
