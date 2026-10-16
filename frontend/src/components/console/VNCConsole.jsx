import { useRef, useEffect, useState, useCallback } from 'react';
import { consoleWsUrl } from '../../api/console.js';
import { getHostInfo } from '../../api/host.js';

let RFBClass = null;
const rfbUrl = `${(import.meta.env.BASE_URL || '/').replace(/\/?$/, '')}/vendor/novnc/core/rfb.js`;
const loadPromise = import(/* @vite-ignore */ rfbUrl)
  .then((m) => { RFBClass = m.default; })
  .catch((err) => console.error('Failed to load noVNC:', err));

const VNC_MAX_RECONNECT_ATTEMPTS = 12;
const VNC_INITIAL_BACKOFF_MS = 1000;
const VNC_MAX_BACKOFF_MS = 30000;

// X11 keysyms for the keys we synthesize during typeText.
const KEYSYM_SHIFT_L = 0xffe1;
const KEYSYM_ENTER = 0xff0d;
const KEYSYM_TAB = 0xff09;

// US-layout shifted symbols → unshifted base char (we wrap with Shift_L).
const SHIFTED_TO_BASE = {
  '!': '1', '@': '2', '#': '3', '$': '4', '%': '5',
  '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
  '_': '-', '+': '=', '{': '[', '}': ']', '|': '\\',
  ':': ';', '"': "'", '<': ',', '>': '.', '?': '/',
  '~': '`',
};

/**
 * Type clipboard text into the guest as VNC key events. QEMU's built-in VNC
 * server has no clipboard bridge to the guest OS, so the standard VNC cut-text
 * path (clipboardPasteFrom) goes nowhere. Synthesizing keystrokes works in any
 * guest. US keyboard layout assumed; uppercase + symbols wrapped in Shift_L.
 * Non-ASCII / non-US-symbol characters are skipped.
 */
function typeText(rfb, text) {
  for (const ch of text) {
    if (ch === '\n' || ch === '\r') {
      rfb.sendKey(KEYSYM_ENTER, 'Enter', true);
      rfb.sendKey(KEYSYM_ENTER, 'Enter', false);
      continue;
    }
    if (ch === '\t') {
      rfb.sendKey(KEYSYM_TAB, 'Tab', true);
      rfb.sendKey(KEYSYM_TAB, 'Tab', false);
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code > 0x7e) continue;

    let keysym = code;
    let shifted = false;
    if (ch >= 'A' && ch <= 'Z') {
      shifted = true;
    } else if (SHIFTED_TO_BASE[ch]) {
      shifted = true;
      keysym = SHIFTED_TO_BASE[ch].charCodeAt(0);
    }

    if (shifted) rfb.sendKey(KEYSYM_SHIFT_L, 'ShiftLeft', true);
    rfb.sendKey(keysym, 'Unidentified', true);
    rfb.sendKey(keysym, 'Unidentified', false);
    if (shifted) rfb.sendKey(KEYSYM_SHIFT_L, 'ShiftLeft', false);
  }
}

/* Close codes from `routes/console.js`. The upgrade is authenticated before it
 * completes, so an expired session has no close code of its own — the browser
 * reports the refused upgrade as 1006. */
const WS_CLOSE_REJECTED = 4000;
const WS_CLOSE_ABNORMAL = 1006;

/**
 * Only a 4000 `invalid name` is permanent. A 4000 `vnc unavailable` (the port
 * briefly reads -1 after start/resume, libvirt not connected) and everything
 * else is transient and retries.
 */
function shouldRetryAfterWsClose(code, reason) {
  return !(code === WS_CLOSE_REJECTED && reason === 'invalid name');
}

export default function VNCConsole({ vmName, viewportRef, apiRef, onConnect, onDisconnect }) {
  const rfbRef = useRef(null);
  /**
   * Monotonic session counter. Every connect() and disconnect() bumps this.
   * All async callbacks (loadPromise, RFB events, reconnect timers) capture
   * the session they belong to and bail when it no longer matches, preventing
   * stale events from an old RFB clobbering a newer connection.
   */
  const sessionRef = useRef(0);
  const [connected, setConnected] = useState(false);
  /** Mirrors `connected` for listeners that run outside React's render (visibility / online). */
  const connectedRef = useRef(false);
  const [error, setError] = useState(null);
  const reconnectTimerRef = useRef(null);
  const reconnectAttemptRef = useRef(0);
  const pendingFrameRef = useRef(null);
  const lastWsCloseRef = useRef(null);
  /** Set by the toolbar's Disconnect; auto-resume (visibility / online / bfcache)
   *  leaves the console closed until the user reconnects. Any connect() clears it. */
  const userDisconnectedRef = useRef(false);
  const vmNameRef = useRef(vmName);
  vmNameRef.current = vmName;

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const teardownRfb = useCallback(() => {
    if (rfbRef.current) {
      try { rfbRef.current.disconnect(); } catch { /* already disconnecting */ }
      rfbRef.current = null;
    }
  }, []);

  const cancelPendingFrame = useCallback(() => {
    if (pendingFrameRef.current != null) {
      cancelAnimationFrame(pendingFrameRef.current);
      pendingFrameRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    if (!viewportRef?.current || !vmName) return;
    const session = ++sessionRef.current;
    userDisconnectedRef.current = false;
    cancelPendingFrame();
    reconnectAttemptRef.current = 0;
    clearReconnectTimer();
    teardownRfb();
    connectedRef.current = false;
    setError(null);
    while (viewportRef.current.firstChild) viewportRef.current.removeChild(viewportRef.current.firstChild);

    function scheduleRetry() {
      if (session !== sessionRef.current) return;
      const n = reconnectAttemptRef.current;
      if (n >= VNC_MAX_RECONNECT_ATTEMPTS) {
        setError(
          'Console connection was lost after several attempts. Ensure the VM is running, then click Retry.',
        );
        return;
      }
      const base = Math.min(VNC_INITIAL_BACKOFF_MS * (2 ** n), VNC_MAX_BACKOFF_MS);
      const jitter = base * 0.15 * Math.random();
      const delay = Math.round(base * 0.85 + jitter);
      reconnectAttemptRef.current += 1;
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        attachRfb();
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

    function attachRfb() {
      if (session !== sessionRef.current) return;
      const name = vmNameRef.current;
      if (!RFBClass || !viewportRef?.current || !name) return;
      while (viewportRef.current.firstChild) viewportRef.current.removeChild(viewportRef.current.firstChild);
      const wsUrl = consoleWsUrl(`/ws/console/${encodeURIComponent(name)}/vnc`);
      try {
        /* The socket is opened here, not by noVNC, so this close listener is
         * registered before noVNC's `onclose`: noVNC dispatches `disconnect`
         * synchronously from its handler, and the close code must already be
         * recorded by then. */
        lastWsCloseRef.current = null;
        const ws = new WebSocket(wsUrl);
        ws.addEventListener('close', (e) => {
          lastWsCloseRef.current = { code: e.code, reason: String(e.reason || '') };
        });
        const rfb = new RFBClass(viewportRef.current, ws, { shared: true });
        rfbRef.current = rfb;
        rfb.addEventListener('connect', () => {
          if (session !== sessionRef.current) return;
          reconnectAttemptRef.current = 0;
          clearReconnectTimer();
          connectedRef.current = true;
          setConnected(true);
          setError(null);
          onConnect?.();
        });
        rfb.addEventListener('disconnect', (ev) => {
          if (session !== sessionRef.current) return;
          connectedRef.current = false;
          setConnected(false);
          rfbRef.current = null;
          onDisconnect?.();
          if (ev.detail?.clean) {
            return;
          }
          if (!vmNameRef.current) return;

          const closeMeta = lastWsCloseRef.current;
          lastWsCloseRef.current = null;
          if (closeMeta && !shouldRetryAfterWsClose(closeMeta.code, closeMeta.reason)) {
            // Invalid name: no auto-retry; keep blank viewport + Reconnect in toolbar
            return;
          }
          if (closeMeta?.code === WS_CLOSE_ABNORMAL) {
            retryAfterAuthCheck();
            return;
          }
          scheduleRetry();
        });
        rfb.addEventListener('securityfailure', (e) => {
          if (session !== sessionRef.current) return;
          setError(e.detail?.reason || 'Security failure');
        });
        rfb.scaleViewport = true;
      } catch (err) {
        setError(err.message || 'Failed to connect');
      }
    }

    loadPromise.then(() => {
      if (session !== sessionRef.current) return;
      if (!RFBClass) {
        setError('noVNC failed to load. Ensure vendor/novnc/core/ is present (run install script).');
        return;
      }
      // Defer to next animation frame so that Strict Mode cleanup (or a fast
      // tab switch) can cancel before any WebSocket is opened.
      pendingFrameRef.current = requestAnimationFrame(() => {
        pendingFrameRef.current = null;
        if (session !== sessionRef.current) return;
        attachRfb();
      });
    });
  }, [vmName, viewportRef, onConnect, onDisconnect, clearReconnectTimer, teardownRfb, cancelPendingFrame]);

  const disconnect = useCallback(() => {
    sessionRef.current += 1;
    cancelPendingFrame();
    clearReconnectTimer();
    reconnectAttemptRef.current = 0;
    const hadRfb = !!rfbRef.current;
    teardownRfb();
    connectedRef.current = false;
    if (hadRfb) {
      setConnected(false);
      onDisconnect?.();
    }
  }, [onDisconnect, clearReconnectTimer, teardownRfb, cancelPendingFrame]);

  const disconnectByUser = useCallback(() => {
    userDisconnectedRef.current = true;
    disconnect();
  }, [disconnect]);

  const isConnected = () => rfbRef.current?._rfbConnectionState === 'connected';

  const sendCtrlAltDel = useCallback(() => {
    if (isConnected()) rfbRef.current.sendCtrlAltDel();
  }, []);

  const paste = useCallback(async () => {
    if (!rfbRef.current || !isConnected()) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text) typeText(rfbRef.current, text);
    } catch (err) {
      console.warn('Clipboard read failed:', err);
    }
  }, []);

  const screenshot = useCallback(() => {
    if (!rfbRef.current || !isConnected()) return;
    rfbRef.current.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `screenshot-${vmName}-${Date.now()}.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  }, [vmName]);

  useEffect(() => {
    if (apiRef) {
      apiRef.current = {
        connect,
        disconnect: disconnectByUser,
        sendCtrlAltDel,
        paste,
        screenshot,
      };
    }
    return () => { if (apiRef) apiRef.current = null; };
  }, [apiRef, connect, disconnectByUser, sendCtrlAltDel, paste, screenshot]);

  useEffect(() => {
    if (vmName && viewportRef?.current) connect();
    return () => disconnect();
  }, [vmName, viewportRef, connect, disconnect]);

  // After laptop sleep or network loss, timers are throttled and the WebSocket is dead.
  // Exponential backoff alone can leave a blank console for minutes; force a fresh attempt
  // when the tab is visible again or the browser reports connectivity. bfcache restore
  // leaves JS state "connected" while the socket is invalid — always reconnect.
  // None of these resume a console the user disconnected on purpose.
  useEffect(() => {
    const resumeIfNeeded = () => {
      if (!vmNameRef.current || !viewportRef?.current) return;
      if (document.visibilityState !== 'visible') return;
      if (connectedRef.current || userDisconnectedRef.current) return;
      connect();
    };
    const onOnline = () => {
      if (!vmNameRef.current || !viewportRef?.current) return;
      if (connectedRef.current || userDisconnectedRef.current) return;
      connect();
    };
    const onPageShow = (e) => {
      if (!e.persisted || !vmNameRef.current || !viewportRef?.current) return;
      if (userDisconnectedRef.current) return;
      connect();
    };
    document.addEventListener('visibilitychange', resumeIfNeeded);
    window.addEventListener('online', onOnline);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      document.removeEventListener('visibilitychange', resumeIfNeeded);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [connect, viewportRef]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-sm text-status-stopped">
        {error}
        <button
          type="button"
          onClick={connect}
          className="ml-2 rounded-sm border border-surface-border px-2 py-1 text-xs hover:bg-surface"
        >
          Retry
        </button>
      </div>
    );
  }
  return null;
}
