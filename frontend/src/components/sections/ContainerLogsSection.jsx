import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { ArrowDown, Circle, Download, Eraser, MapPin, RefreshCw, Search } from 'lucide-react';
import { createSSE } from '../../api/sse.js';
import { listContainerRuns } from '../../api/containers.js';
import { getToken } from '../../api/client.js';
import { useContainerStore } from '../../store/containerStore.js';
import { randomId } from '../../utils/randomId.js';

const CLIENT_BUFFER_HARD_LIMIT = 5000;
const CLIENT_BUFFER_TRIM_TO = 4000;

/** Format `YYYY-MM-DDTHH-MM-SS-mmmZ` → `HH:MM:SS` (local time). */
function formatRunTime(startedAt) {
  if (!startedAt) return '—';
  const d = new Date(startedAt);
  if (Number.isNaN(d.getTime())) return startedAt;
  return d.toLocaleString([], {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function formatDuration(startedAt, endedAt) {
  if (!startedAt) return '';
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  const ms = Math.max(0, end - start);
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function runLabel(run) {
  if (!run) return '';
  const when = formatRunTime(run.startedAt);
  const dur = formatDuration(run.startedAt, run.endedAt);
  if (!run.endedAt) return `${when} · running (${dur})`;
  const code = typeof run.exitCode === 'number' ? ` · exit ${run.exitCode}` : '';
  return `${when} · ${dur}${code}`;
}

/** Clock time — used on clear/mark dividers so the user can orient in the stream. */
function nowClock() {
  return new Date().toLocaleTimeString([], { hour12: false });
}

export default function ContainerLogsSection({ containerName }) {
  const containerState = useContainerStore((s) => (
    s.selectedContainer === containerName ? s.containerConfig?.state : null
  ));

  const [runs, setRuns] = useState([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState(null);
  /** True while the user is on the newest run — follow new runs automatically on next start. */
  const [followLatest, setFollowLatest] = useState(true);
  const [entries, setEntries] = useState([]);
  const [filter, setFilter] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);

  const logRef = useRef(null);
  const closeSseRef = useRef(null);

  const refetchRuns = useCallback(async () => {
    setRunsLoading(true);
    try {
      const { runs: next } = await listContainerRuns(containerName);
      setRuns(next || []);
      return next || [];
    } catch {
      setRuns([]);
      return [];
    } finally {
      setRunsLoading(false);
    }
  }, [containerName]);

  // Initial fetch + refetch whenever the container transitions state.
  // State comes from the containers list / stats SSE, so this is event-driven.
  useEffect(() => {
    refetchRuns();
  }, [refetchRuns, containerState]);

  // Pick the newest run when the list updates, provided the user hasn't pinned an older one.
  useEffect(() => {
    if (!runs.length) {
      setSelectedRunId(null);
      return;
    }
    if (followLatest) {
      setSelectedRunId(runs[0].runId);
    } else if (!runs.some((r) => r.runId === selectedRunId)) {
      // Previously-selected run was pruned out of retention — snap to latest.
      setSelectedRunId(runs[0].runId);
      setFollowLatest(true);
    }
  }, [runs, followLatest, selectedRunId]);

  // Tail (and replay history for) the selected run.
  useEffect(() => {
    setEntries([]);
    if (closeSseRef.current) {
      closeSseRef.current();
      closeSseRef.current = null;
    }
    if (!selectedRunId) return undefined;

    const q = `?runId=${encodeURIComponent(selectedRunId)}`;
    closeSseRef.current = createSSE(
      `/api/containers/${encodeURIComponent(containerName)}/logs${q}`,
      (data) => {
        if (data.type === 'history' && Array.isArray(data.lines)) {
          setEntries(data.lines.map((text) => ({ id: randomId(), kind: 'line', text })));
        } else if (data.type === 'line' && data.line) {
          setEntries((prev) => {
            const next = [...prev, { id: randomId(), kind: 'line', text: data.line }];
            if (next.length > CLIENT_BUFFER_HARD_LIMIT) return next.slice(-CLIENT_BUFFER_TRIM_TO);
            return next;
          });
        }
      },
      () => { /* createSSE reconnects on failure */ },
    );

    return () => {
      if (closeSseRef.current) {
        closeSseRef.current();
        closeSseRef.current = null;
      }
    };
  }, [containerName, selectedRunId]);

  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [entries, autoScroll]);

  const handleScroll = useCallback(() => {
    if (!logRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 50);
  }, []);

  const selectedRun = useMemo(
    () => runs.find((r) => r.runId === selectedRunId) || null,
    [runs, selectedRunId],
  );

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return entries;
    return entries.filter((e) => {
      if (e.kind !== 'line') return true; // keep dividers visible while filtering
      return typeof e.text === 'string' && e.text.toLowerCase().includes(f);
    });
  }, [entries, filter]);

  const onPickRun = useCallback((e) => {
    const runId = e.target.value;
    setSelectedRunId(runId);
    setFollowLatest(runs.length > 0 && runId === runs[0].runId);
  }, [runs]);

  const onClear = useCallback(() => {
    setEntries([{ id: randomId(), kind: 'divider', text: `— cleared ${nowClock()} —` }]);
  }, []);

  const onMark = useCallback(() => {
    const label = window.prompt('Mark label (optional):', '');
    if (label === null) return;
    const trimmed = label.trim();
    const text = trimmed ? `— mark: ${trimmed} @ ${nowClock()} —` : `— mark @ ${nowClock()} —`;
    setEntries((prev) => [...prev, { id: randomId(), kind: 'divider', text }]);
  }, []);

  const downloadHref = useMemo(() => {
    if (!selectedRunId) return null;
    const token = getToken();
    if (!token) return null;
    return `/api/containers/${encodeURIComponent(containerName)}/runs/${encodeURIComponent(selectedRunId)}/log?token=${encodeURIComponent(token)}`;
  }, [containerName, selectedRunId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-surface-border px-4 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {selectedRun && (
            <Circle
              size={8}
              aria-hidden
              className={
                !selectedRun.endedAt
                  ? 'fill-emerald-500 text-emerald-500'
                  : (typeof selectedRun.exitCode === 'number' && selectedRun.exitCode !== 0)
                    ? 'fill-red-500 text-red-500'
                    : 'fill-text-muted text-text-muted'
              }
            />
          )}
          <select
            value={selectedRunId || ''}
            onChange={onPickRun}
            disabled={runs.length === 0}
            title="Select a run"
            className="max-w-[22rem] truncate rounded-md border border-surface-border bg-surface-card px-2 py-1.5 text-xs text-text-primary outline-none focus:border-accent transition-colors duration-150 disabled:opacity-50"
          >
            {runs.length === 0 && <option value="">No runs yet</option>}
            {runs.map((r) => (
              <option key={r.runId} value={r.runId}>{runLabel(r)}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={refetchRuns}
            disabled={runsLoading}
            className="shrink-0 rounded-md p-1.5 text-text-muted hover:text-text-secondary transition-colors duration-150 disabled:opacity-50"
            title="Refresh run list"
            aria-label="Refresh run list"
          >
            <RefreshCw size={14} className={runsLoading ? 'animate-spin' : ''} aria-hidden />
          </button>
        </div>

        <div className="relative min-w-0 flex-1">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter logs…"
            className="w-full rounded-md border border-surface-border bg-surface-card pl-8 pr-3 py-1.5 text-xs text-text-primary placeholder:text-text-muted outline-none focus:border-accent transition-colors duration-150"
          />
        </div>

        <button
          type="button"
          onClick={onClear}
          className="rounded-md p-1.5 text-text-muted hover:text-text-secondary transition-colors duration-150"
          title="Clear viewer (does not touch log files)"
          aria-label="Clear viewer"
        >
          <Eraser size={14} aria-hidden />
        </button>
        <button
          type="button"
          onClick={onMark}
          className="rounded-md p-1.5 text-text-muted hover:text-text-secondary transition-colors duration-150"
          title="Insert a marker line"
          aria-label="Insert a marker line"
        >
          <MapPin size={14} aria-hidden />
        </button>
        {downloadHref ? (
          <a
            href={downloadHref}
            download={`${containerName}-${selectedRunId}.log`}
            className="rounded-md p-1.5 text-text-muted hover:text-text-secondary transition-colors duration-150"
            title="Download this run's log"
            aria-label="Download run log"
          >
            <Download size={14} aria-hidden />
          </a>
        ) : null}
        <button
          type="button"
          onClick={() => {
            setAutoScroll(true);
            if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
          }}
          className={`rounded-md p-1.5 transition-colors duration-150 ${
            autoScroll ? 'text-accent bg-accent/10' : 'text-text-muted hover:text-text-secondary'
          }`}
          title="Auto-scroll"
          aria-label="Auto-scroll"
        >
          <ArrowDown size={14} aria-hidden />
        </button>
        <span className="text-[10px] text-text-muted">{filtered.length} lines</span>
      </div>

      <div
        ref={logRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto bg-surface-sidebar p-4 font-mono text-xs leading-5 text-text-primary"
      >
        {filtered.length === 0 ? (
          <span className="text-text-muted">
            {selectedRunId ? 'No logs for this run.' : 'No logs available.'}
          </span>
        ) : (
          filtered.map((e) => (
            e.kind === 'divider' ? (
              <div key={e.id} className="my-1 select-none text-center text-[10px] uppercase tracking-wider text-text-muted">
                {e.text}
              </div>
            ) : (
              <div key={e.id} className="whitespace-pre-wrap break-all hover:bg-surface-card/50">
                {e.text}
              </div>
            )
          ))
        )}
      </div>
    </div>
  );
}
