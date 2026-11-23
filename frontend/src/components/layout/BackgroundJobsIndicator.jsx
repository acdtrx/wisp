import { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ListTodo, X } from 'lucide-react';

import { runningJobs, useBackgroundJobsStore } from '../../store/backgroundJobsStore.js';
import { usePopover } from '../../lib/popover.js';
import { errorText } from '../../api/errors.js';
import ErrorBanner from '../shared/ErrorBanner.jsx';
import IconButton from '../shared/IconButton.jsx';

/** A row the topic lists as failed shows no text until its stream's replay brings the error. */
function formatStep(row) {
  if (row.status === 'done') return 'Done';
  if (row.status === 'cancelled') return 'Cancelled';
  if (row.status === 'error') return row.error ? errorText(row.error) : null;
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
      className="mt-2 overflow-hidden rounded-full bg-surface-border/90 p-[2px] inset-shadow-xs"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(p)}
    >
      <div className="h-2 overflow-hidden rounded-full bg-surface/80">
        <div
          className={`h-full rounded-full transition-[width] duration-500 ease-out ${
            isDone
              ? 'bg-status-running shadow-xs'
              : 'bg-linear-to-r from-accent to-accent-bright shadow-xs shadow-accent/35'
          }`}
          style={{ width: `${p}%` }}
        />
      </div>
    </div>
  );
}

export default function BackgroundJobsIndicator() {
  const jobs = useBackgroundJobsStore((s) => s.jobs);
  const streamError = useBackgroundJobsStore((s) => s.error);
  const dismissStreamError = useBackgroundJobsStore((s) => s.dismissError);
  const dismissJob = useBackgroundJobsStore((s) => s.dismissJob);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef(null);
  const popRef = useRef(null);
  const close = useCallback(() => setOpen(false), []);

  const list = Object.values(jobs).sort((a, b) => b.createdAt - a.createdAt);
  const running = runningJobs(jobs).length;

  /* Nothing to open: no row, and no stream error to show. */
  const isEmpty = list.length === 0 && !streamError;
  const popStyle = usePopover(open && !isEmpty, { anchorRef, popRef, onClose: close, align: 'end' });
  /* Emptied (last row dismissed): closed for good, so the next job doesn't
   * reopen the tray and pull focus to it. */
  useEffect(() => {
    if (isEmpty && open) setOpen(false);
  }, [isEmpty, open]);

  return (
    <div className="relative shrink-0">
      <IconButton
        ref={anchorRef}
        icon={ListTodo}
        label="Background jobs"
        title={isEmpty ? 'No background jobs' : streamError ? `Background jobs — couldn't load the job list: ${streamError}` : 'Background jobs'}
        variant="neutral"
        size="lg"
        disabled={isEmpty}
        aria-expanded={open}
        onClick={() => !isEmpty && setOpen((o) => !o)}
        badge={(
          <>
            {streamError && running === 0 && (
              <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-status-stopped" aria-hidden />
            )}
            {running > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-white">
                {running > 9 ? '9+' : running}
              </span>
            )}
          </>
        )}
      />

      {open && !isEmpty && createPortal(
        <div
          ref={popRef}
          tabIndex={-1}
          style={popStyle}
          aria-label="Background jobs"
          className="z-[60] w-[min(100vw-2rem,22rem)] overflow-y-auto rounded-lg border border-surface-border bg-surface-card py-1 shadow-popover outline-hidden"
        >
          <div className="border-b border-surface-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            Background jobs
          </div>
          <ErrorBanner
            className="mx-3 my-2"
            error={streamError}
            prefix="Couldn't load the job list"
            onDismiss={list.length > 0 ? dismissStreamError : undefined}
          />
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
                    <IconButton icon={X} label="Dismiss" size="sm" onClick={() => dismissJob(row.jobId)} />
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>,
        document.body,
      )}
    </div>
  );
}
