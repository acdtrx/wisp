import { useRef, useEffect, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

import { consoleWsUrl } from '../../api/console.js';
import { getHostInfo } from '../../api/host.js';
import { useThemeStore } from '../../store/themeStore.js';
import { consoleTheme } from './consoleTheme.js';

const MAX_RECONNECT_ATTEMPTS = 12;
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

/* Close codes from `routes/containerConsole.js`. The upgrade is authenticated
 * before it completes, so an expired session never gets a close code of its
 * own — the browser reports the refused upgrade as 1006 (see onWsClose). */
const WS_CLOSE_SESSION_ENDED = 1000;
const WS_CLOSE_EXEC_FAILED = 4000;
const WS_CLOSE_ABNORMAL = 1006;

const LOST_MESSAGE = 'Console connection was lost after several attempts. Ensure the container is running, then click Retry.';
const EXEC_FAILED_MESSAGE = 'Could not start a shell in the container. The image may not include /bin/sh — the server log has the details.';

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
  /** Monotonic session counter, bumped by every connect() and disconnect(). Socket
   *  events, the auth check and retry timers capture their session and bail once it
   *  no longer matches. Retries within one session keep its number. */
  const sessionRef = useRef(0);
  const reconnectTimerRef = useRef(null);
  /** Consecutive attempts without a working shell. Reset by connect() and by the
   *  first output frame of a session — not by the socket opening, because the server
   *  accepts the upgrade before it tries the exec. */
  const reconnectAttemptRef = useRef(0);
  const pendingFrameRef = useRef(null);
  const containerNameRef = useRef(containerName);
  const isRunningRef = useRef(isRunning);
  const connectedRef = useRef(false);
  /** The console stays closed until the user reconnects: set by the toolbar's
   *  Disconnect, the shell exiting, and a failed exec. Auto-resume (visibility /
   *  online) skips it; any connect() clears it. */
  const holdClosedRef = useRef(false);
  const onConnectRef = useRef(onConnect);
  const onDisconnectRef = useRef(onDisconnect);
  containerNameRef.current = containerName;
  isRunningRef.current = isRunning;
  onConnectRef.current = onConnect;
  onDisconnectRef.current = onDisconnect;

  /** `{ kind: 'error' | 'ended', message }` — shown over the viewport. */
  const [notice, setNotice] = useState(null);
  /* Only used to re-apply the palette below; `connect` reads the tokens itself,
     so a theme flip must not make the connect callback a new identity and
     re-open the session. */
  const effectiveTheme = useThemeStore((s) => s.effective);

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

  const disposeTerminal = useCallback(() => {
    if (!termRef.current) return false;
    try {
      termRef.current.dispose();
    } catch { /* already disposed */ }
    termRef.current = null;
    fitAddonRef.current = null;
    return true;
  }, []);

  const sendResize = useCallback((ws, cols, rows) => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  }, []);

  const connect = useCallback(() => {
    if (!viewportRef?.current || !containerName) return;
    if (!isRunningRef.current) {
      setNotice({ kind: 'error', message: 'Start the container to use the console.' });
      return;
    }

    const session = ++sessionRef.current;
    holdClosedRef.current = false;
    cancelPendingFrame();
    reconnectAttemptRef.current = 0;
    clearReconnectTimer();
    teardownWs();
    disposeTerminal();
    connectedRef.current = false;
    setNotice(null);

    /** Waits out the backoff, then tries again within this session — the attempt
     *  count carries over, so a shell that never starts gives up after the cap. */
    function scheduleRetry() {
      if (session !== sessionRef.current) return;
      const n = reconnectAttemptRef.current;
      if (n >= MAX_RECONNECT_ATTEMPTS) {
        setNotice({ kind: 'error', message: LOST_MESSAGE });
        return;
      }
      const base = Math.min(INITIAL_BACKOFF_MS * (2 ** n), MAX_BACKOFF_MS);
      const jitter = base * 0.15 * Math.random();
      const delay = Math.round(base * 0.85 + jitter);
      reconnectAttemptRef.current += 1;
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        attach();
      }, delay);
    }

    /** A refused upgrade (expired session) and a dropped network both close as 1006.
     *  An authenticated GET tells them apart: on 401 `api()` sends the user to the
     *  sign-in page; anything else retries. */
    function retryAfterAuthCheck() {
      getHostInfo().then(
        () => scheduleRetry(),
        (err) => {
          if (err?.message === 'Session expired') return;
          scheduleRetry();
        },
      );
    }

    function attach() {
      if (session !== sessionRef.current) return;
      if (!viewportRef.current || !containerNameRef.current) return;

      viewportRef.current.innerHTML = '';
      const term = new Terminal({
        cursorBlink: true,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        theme: consoleTheme(),
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
        setNotice({ kind: 'error', message: err?.message || 'Failed to open WebSocket' });
        disposeTerminal();
        return;
      }
      wsRef.current = ws;
      let sawOutput = false;

      const resizeObserver = new ResizeObserver(() => {
        if (session !== sessionRef.current || !termRef.current || !fitAddonRef.current) return;
        try {
          fitAddonRef.current.fit();
          const t = termRef.current;
          sendResize(wsRef.current, t.cols, t.rows);
        } catch { /* fit during teardown */ }
      });
      resizeObserver.observe(viewportRef.current);

      ws.addEventListener('open', () => {
        if (session !== sessionRef.current) return;
        connectedRef.current = true;
        setNotice(null);
        try {
          fitAddonRef.current?.fit();
          const t = termRef.current;
          if (t && wsRef.current?.readyState === WebSocket.OPEN) {
            sendResize(wsRef.current, t.cols, t.rows);
          }
        } catch { /* ignore */ }
        onConnectRef.current?.();
      });

      const writeOutput = (bytes) => {
        if (session !== sessionRef.current || !termRef.current) return;
        if (!sawOutput) {
          sawOutput = true;
          reconnectAttemptRef.current = 0;
        }
        termRef.current.write(bytes);
      };

      ws.addEventListener('message', (ev) => {
        if (ev.data instanceof ArrayBuffer) {
          writeOutput(new Uint8Array(ev.data));
        } else if (ev.data instanceof Blob) {
          ev.data.arrayBuffer().then((ab) => writeOutput(new Uint8Array(ab)));
        }
      });

      ws.addEventListener('close', (e) => {
        try {
          resizeObserver.disconnect();
        } catch { /* ignore */ }
        if (session !== sessionRef.current) return;
        wsRef.current = null;
        connectedRef.current = false;
        onDisconnectRef.current?.();
        disposeTerminal();
        if (!isRunningRef.current) return;

        if (e.code === WS_CLOSE_SESSION_ENDED) {
          holdClosedRef.current = true;
          setNotice({ kind: 'ended', message: 'Session ended.' });
          return;
        }
        if (e.code === WS_CLOSE_EXEC_FAILED) {
          holdClosedRef.current = true;
          setNotice({ kind: 'error', message: EXEC_FAILED_MESSAGE });
          return;
        }
        if (e.code === WS_CLOSE_ABNORMAL) {
          retryAfterAuthCheck();
          return;
        }
        scheduleRetry();
      });

      ws.addEventListener('error', () => {
        /* close event follows */
      });

      term.onData((data) => {
        if (session !== sessionRef.current || ws.readyState !== WebSocket.OPEN) return;
        ws.send(new TextEncoder().encode(data));
      });
    }

    pendingFrameRef.current = requestAnimationFrame(() => {
      pendingFrameRef.current = null;
      attach();
    });
  }, [viewportRef, containerName, clearReconnectTimer, cancelPendingFrame, teardownWs, disposeTerminal, sendResize]);

  const connectRef = useRef(connect);
  connectRef.current = connect;

  const disconnect = useCallback(() => {
    sessionRef.current += 1;
    cancelPendingFrame();
    clearReconnectTimer();
    reconnectAttemptRef.current = 0;
    teardownWs();
    connectedRef.current = false;
    if (disposeTerminal()) onDisconnectRef.current?.();
  }, [cancelPendingFrame, clearReconnectTimer, teardownWs, disposeTerminal]);

  const disconnectByUser = useCallback(() => {
    holdClosedRef.current = true;
    disconnect();
  }, [disconnect]);

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
        disconnect: disconnectByUser,
        paste: pasteFromClipboard,
      };
    }
    return () => {
      if (apiRef) apiRef.current = null;
    };
  }, [apiRef, disconnectByUser, pasteFromClipboard]);

  /* A live terminal repaints on a theme flip — no reconnect, no lost scrollback. */
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = consoleTheme();
  }, [effectiveTheme]);

  useEffect(() => {
    if (!containerName || !isRunning) return undefined;
    connectRef.current();
    return () => {
      disconnect();
    };
  }, [containerName, isRunning, disconnect]);

  /* Resume a dropped session when the tab returns or the network comes back —
     never one held closed (user Disconnect, shell exited, exec failed). */
  useEffect(() => {
    const resumeIfNeeded = () => {
      if (!containerNameRef.current || !viewportRef?.current) return;
      if (document.visibilityState !== 'visible') return;
      if (connectedRef.current || holdClosedRef.current) return;
      if (!isRunningRef.current) return;
      connectRef.current();
    };
    const onOnline = () => {
      if (!containerNameRef.current || !viewportRef?.current) return;
      if (connectedRef.current || holdClosedRef.current) return;
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

  if (!notice) return null;

  const ended = notice.kind === 'ended';
  return (
    <div
      className={`absolute inset-0 z-10 flex items-center justify-center bg-surface-card/95 p-4 text-center text-sm ${
        ended ? 'text-text-secondary' : 'text-status-stopped'
      }`}
    >
      <span>{notice.message}</span>
      <button
        type="button"
        onClick={() => connectRef.current()}
        className="ml-2 rounded-sm border border-surface-border px-2 py-1 text-xs hover:bg-surface"
      >
        {ended ? 'Reconnect' : 'Retry'}
      </button>
    </div>
  );
}
