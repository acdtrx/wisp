import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { ArrowDown, Search } from 'lucide-react';
import { createSSE } from '../../api/sse.js';
import { randomId } from '../../utils/randomId.js';

export default function ContainerLogsSection({ containerName }) {
  const [lines, setLines] = useState([]);
  const [filter, setFilter] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const logRef = useRef(null);
  const closeRef = useRef(null);

  useEffect(() => {
    setLines([]);

    closeRef.current = createSSE(
      `/api/containers/${encodeURIComponent(containerName)}/logs`,
      (data) => {
        if (data.type === 'history' && Array.isArray(data.lines)) {
          setLines(data.lines.map((text) => ({ id: randomId(), text })));
        } else if (data.type === 'line' && data.line) {
          setLines((prev) => {
            const next = [...prev, { id: randomId(), text: data.line }];
            if (next.length > 5000) return next.slice(-4000);
            return next;
          });
        }
      },
      () => {
        /* createSSE reconnects on failure; no extra UI */
      },
    );

    return () => {
      if (closeRef.current) closeRef.current();
    };
  }, [containerName]);

  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [lines, autoScroll]);

  const handleScroll = useCallback(() => {
    if (!logRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 50);
  }, []);

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return lines;
    return lines.filter((l) => {
      const t = l?.text;
      if (t == null || typeof t !== 'string') return false;
      return t.toLowerCase().includes(f);
    });
  }, [lines, filter]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-surface-border px-4 py-2">
        <div className="relative flex-1">
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
          onClick={() => {
            setAutoScroll(true);
            if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
          }}
          className={`rounded-md p-1.5 transition-colors duration-150 ${
            autoScroll ? 'text-accent bg-accent/10' : 'text-text-muted hover:text-text-secondary'
          }`}
          title="Auto-scroll"
        >
          <ArrowDown size={14} />
        </button>
        <span className="text-[10px] text-text-muted">{filtered.length} lines</span>
      </div>

      <div
        ref={logRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto bg-surface-sidebar p-4 font-mono text-xs leading-5 text-text-primary"
      >
        {filtered.length === 0 ? (
          <span className="text-text-muted">No logs available.</span>
        ) : (
          filtered.map((line) => (
            <div key={line.id} className="whitespace-pre-wrap break-all hover:bg-surface-card/50">
              {line.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
