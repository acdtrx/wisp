import { useRef, useEffect, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

import { consoleWsUrl } from '../../api/console.js';

const MAX_RECONNECT_ATTEMPTS = 12;
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

function shouldRetryAfterWsClose(code) {
  if (code === 4001) return false;
  return true;
}

/**
 * @param {object} props
 * @param {string} props.containerName
 * @param {boolean} props.isRunning
 * @param {React.RefObject<HTMLDivElement | null>} props.viewportRef
 * @param {React.MutableRefObject<{ connect: () => void, disconnect: () => void } | null>} props.apiRef
 * @param {() => void} [props.onConnect]
 * @param {() => void} [props.onDisconnect]
 */
export default function ContainerConsole({
  containerName,
  isRunning,
  viewportRef,
  apiRef,
  onConnect,
  onDisconnect,
}) {
  const termRef = useRef(null);
  const fitAddonRef = useRef(null);
  const wsRef = useRef(null);
  const sessionRef = useRef(0);
  const reconnectTimerRef = useRef(null);
  const reconnectAttemptRef = useRef(0);
  const pendingFrameRef = useRef(null);
  const lastWsCloseRef = useRef(null);
  const containerNameRef = useRef(containerName);
  const isRunningRef = useRef(isRunning);
  const connectedRef = useRef(false);
  const onConnectRef = useRef(onConnect);
  const onDisconnectRef = useRef(onDisconnect);
  containerNameRef.current = containerName;
  isRunningRef.current = isRunning;
  onConnectRef.current = onConnect;
  onDisconnectRef.current = onDisconnect;

  const [error, setError] = useState(null);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const cancelPendingFrame = useCallback(() => {
    if (pendingFrameRef.current != null) {
      cancelAnimationFrame(pendingFrameRef.current);
      pendingFrameRef.current = null;
    }
  }, []);

  const teardownWs = useCallback(() => {
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      try {
        ws.close();
      } catch { /* already closing */ }
    }
  }, []);

  const sendResize = useCallback((ws, cols, rows) => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  }, []);

  const connect = useCallback(() => {
    if (!viewportRef?.current || !containerName) return;
    if (!isRunningRef.current) {
      setError('Start the container to use the console.');
      return;
    }

    const session = ++sessionRef.current;
    cancelPendingFrame();
    reconnectAttemptRef.current = 0;
    clearReconnectTimer();
    teardownWs();
    connectedRef.current = false;
    setError(null);

    pendingFrameRef.current = requestAnimationFrame(() => {
      pendingFrameRef.current = null;
      if (session !== sessionRef.current) return;
      if (!viewportRef.current || !containerNameRef.current) return;

      viewportRef.current.innerHTML = '';
      const term = new Terminal({
        cursorBlink: true,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        theme: {
          background: '#1e293b',
          foreground: '#e2e8f0',
        },
      });
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(viewportRef.current);
      fitAddon.fit();
      termRef.current = term;
      fitAddonRef.current = fitAddon;

      const cols = term.cols;
      const rows = term.rows;
      const path = `/ws/container-console/${encodeURIComponent(containerNameRef.current)}?cols=${cols}&rows=${rows}`;
      const wsUrl = consoleWsUrl(path);
      let ws;
      try {
        ws = new WebSocket(wsUrl);
        ws.binaryType = 'arraybuffer';
      } catch (err) {
        setError(err?.message || 'Failed to open WebSocket');
        term.dispose();
        termRef.current = null;
        fitAddonRef.current = null;
        return;
      }
      wsRef.current = ws;

      const resizeObserver = new ResizeObserver(() => {
        if (session !== sessionRef.current || !termRef.current || !fitAddonRef.current) return;
        try {
          fitAddonRef.current.fit();
          const t = termRef.current;
          sendResize(wsRef.current, t.cols, t.rows);
        } catch { /* fit during teardown */ }
      });
      resizeObserver.observe(viewportRef.current);

      const onWsOpen = () => {
        if (session !== sessionRef.current) return;
        reconnectAttemptRef.current = 0;
        clearReconnectTimer();
        connectedRef.current = true;
        setError(null);
        try {
          fitAddonRef.current?.fit();
          const t = termRef.current;
          if (t && wsRef.current?.readyState === WebSocket.OPEN) {
            sendResize(wsRef.current, t.cols, t.rows);
          }
        } catch { /* ignore */ }
        onConnectRef.current?.();
      };

      const scheduleReconnect = () => {
        if (session !== sessionRef.current) return;
        if (!containerNameRef.current || !isRunningRef.current) return;
        const closeMeta = lastWsCloseRef.current;
        lastWsCloseRef.current = null;
        if (closeMeta && !shouldRetryAfterWsClose(closeMeta.code)) {
          if (closeMeta.code === 4001) {
            setError('Session expired. Refresh the page and sign in again.');
          }
          return;
        }
        const n = reconnectAttemptRef.current;
        if (n >= MAX_RECONNECT_ATTEMPTS) {
          setError('Console connection was lost after several attempts. Ensure the container is running, then click Retry.');
          return;
        }
        const base = Math.min(INITIAL_BACKOFF_MS * (2 ** n), MAX_BACKOFF_MS);
        const jitter = base * 0.15 * Math.random();
        const delay = Math.round(base * 0.85 + jitter);
        reconnectAttemptRef.current += 1;
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          connectRef.current?.();
        }, delay);
      };

      ws.addEventListener('open', onWsOpen);

      ws.addEventListener('message', (ev) => {
        if (session !== sessionRef.current || !termRef.current) return;
        if (ev.data instanceof ArrayBuffer) {
          termRef.current.write(new Uint8Array(ev.data));
        } else if (ev.data instanceof Blob) {
          ev.data.arrayBuffer().then((ab) => {
            if (session !== sessionRef.current || !termRef.current) return;
            termRef.current.write(new Uint8Array(ab));
          });
        }
      });

      ws.addEventListener('close', (e) => {
        lastWsCloseRef.current = { code: e.code };
        try {
          resizeObserver.disconnect();
        } catch { /* ignore */ }
        if (session !== sessionRef.current) return;
        connectedRef.current = false;
        onDisconnectRef.current?.();
        termRef.current?.dispose();
        termRef.current = null;
        fitAddonRef.current = null;
        if (e.code !== 1000 && e.code !== 1001 && isRunningRef.current) {
          scheduleReconnect();
        }
      });

      ws.addEventListener('error', () => {
        /* close event follows */
      });

      term.onData((data) => {
        if (session !== sessionRef.current || ws.readyState !== WebSocket.OPEN) return;
        ws.send(new TextEncoder().encode(data));
      });
    });
  }, [viewportRef, containerName, clearReconnectTimer, cancelPendingFrame, teardownWs, sendResize]);

  const connectRef = useRef(connect);
  connectRef.current = connect;

  const disconnect = useCallback(() => {
    sessionRef.current += 1;
    cancelPendingFrame();
    clearReconnectTimer();
    reconnectAttemptRef.current = 0;
    teardownWs();
    connectedRef.current = false;
    if (termRef.current) {
      try {
        termRef.current.dispose();
      } catch { /* ignore */ }
      termRef.current = null;
      fitAddonRef.current = null;
      onDisconnectRef.current?.();
    }
  }, [cancelPendingFrame, clearReconnectTimer, teardownWs]);

  const pasteFromClipboard = useCallback(async () => {
    const term = termRef.current;
    if (!term) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text) term.paste(text);
    } catch (err) {
      console.warn('Clipboard read failed:', err);
    }
  }, []);

  useEffect(() => {
    if (apiRef) {
      apiRef.current = {
        connect: () => connectRef.current(),
        disconnect,
        paste: pasteFromClipboard,
      };
    }
    return () => {
      if (apiRef) apiRef.current = null;
    };
  }, [apiRef, disconnect, pasteFromClipboard]);

  useEffect(() => {
    if (!containerName || !isRunning) return undefined;
    connectRef.current();
    return () => {
      disconnect();
    };
  }, [containerName, isRunning, disconnect]);

  useEffect(() => {
    const resumeIfNeeded = () => {
      if (!containerNameRef.current || !viewportRef?.current) return;
      if (document.visibilityState !== 'visible') return;
      if (connectedRef.current) return;
      if (!isRunningRef.current) return;
      connectRef.current();
    };
    const onOnline = () => {
      if (!containerNameRef.current || !viewportRef?.current) return;
      if (connectedRef.current) return;
      if (!isRunningRef.current) return;
      connectRef.current();
    };
    document.addEventListener('visibilitychange', resumeIfNeeded);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', resumeIfNeeded);
      window.removeEventListener('online', onOnline);
    };
  }, [viewportRef]);

  if (error) {
    return (
      <div className="absolute inset-0 z-10 flex items-center justify-center bg-surface-card/95 p-4 text-center text-sm text-status-stopped">
        <span>{error}</span>
        <button
          type="button"
          onClick={() => connectRef.current()}
          className="ml-2 rounded border border-surface-border px-2 py-1 text-xs hover:bg-surface"
        >
          Retry
        </button>
      </div>
    );
  }

  return null;
}
