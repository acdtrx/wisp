import { useRef, useEffect, useState, useCallback } from 'react';
import { consoleWsUrl } from '../../api/console.js';

let RFBClass = null;
const rfbUrl = `${(import.meta.env.BASE_URL || '/').replace(/\/?$/, '')}/vendor/novnc/core/rfb.js`;
const loadPromise = import(/* @vite-ignore */ rfbUrl)
  .then((m) => { RFBClass = m.default; })
  .catch((err) => console.error('Failed to load noVNC:', err));

const VNC_MAX_RECONNECT_ATTEMPTS = 12;
const VNC_INITIAL_BACKOFF_MS = 1000;
const VNC_MAX_BACKOFF_MS = 30000;

/**
 * Return false only for 4000/4001 closes that are known-permanent (bad VM name, auth).
 * Everything else — VNC port not available, VM not found, libvirt errors — is transient
 * (port briefly shows -1 after resume/start) and should still retry.
 * 4001 = auth failure; never retry.
 */
function shouldRetryAfterWsClose(code, reason) {
  if (code === 4001) return false;
  if (code === 4000) {
    const r = String(reason || '');
    if (/invalid vm name/i.test(r)) return false;
    if (/authentication required/i.test(r)) return false;
    return true;
  }
  return true;
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
    cancelPendingFrame();
    reconnectAttemptRef.current = 0;
    clearReconnectTimer();
    teardownRfb();
    connectedRef.current = false;
    setError(null);
    while (viewportRef.current.firstChild) viewportRef.current.removeChild(viewportRef.current.firstChild);

    function attachRfb() {
      if (session !== sessionRef.current) return;
      const name = vmNameRef.current;
      if (!RFBClass || !viewportRef?.current || !name) return;
      while (viewportRef.current.firstChild) viewportRef.current.removeChild(viewportRef.current.firstChild);
      const wsUrl = consoleWsUrl(`/ws/console/${encodeURIComponent(name)}/vnc`);
      try {
        const rfb = new RFBClass(viewportRef.current, wsUrl, { shared: true });
        rfbRef.current = rfb;
        lastWsCloseRef.current = null;
        const rawWs = rfb._sock?._websocket;
        if (rawWs) {
          rawWs.addEventListener('close', (e) => {
            lastWsCloseRef.current = { code: e.code, reason: String(e.reason || '') };
          });
        }
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
            if (closeMeta.code === 4001) {
              setError('Session expired. Refresh the page and sign in again.');
            }
            // 4000 etc.: no auto-retry (avoids devtools spam); keep blank viewport + Reconnect in toolbar
            return;
          }

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

  const isConnected = () => rfbRef.current?._rfbConnectionState === 'connected';

  const sendCtrlAltDel = useCallback(() => {
    if (isConnected()) rfbRef.current.sendCtrlAltDel();
  }, []);

  const paste = useCallback(async () => {
    if (!rfbRef.current || !isConnected()) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text) rfbRef.current.clipboardPasteFrom(text);
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
        disconnect,
        sendCtrlAltDel,
        paste,
        screenshot,
      };
    }
    return () => { if (apiRef) apiRef.current = null; };
  }, [apiRef, connect, disconnect, sendCtrlAltDel, paste, screenshot]);

  useEffect(() => {
    if (vmName && viewportRef?.current) connect();
    return () => disconnect();
  }, [vmName, viewportRef, connect, disconnect]);

  // After laptop sleep or network loss, timers are throttled and the WebSocket is dead.
  // Exponential backoff alone can leave a blank console for minutes; force a fresh attempt
  // when the tab is visible again or the browser reports connectivity. bfcache restore
  // leaves JS state "connected" while the socket is invalid — always reconnect.
  useEffect(() => {
    const resumeIfNeeded = () => {
      if (!vmNameRef.current || !viewportRef?.current) return;
      if (document.visibilityState !== 'visible') return;
      if (connectedRef.current) return;
      connect();
    };
    const onOnline = () => {
      if (!vmNameRef.current || !viewportRef?.current) return;
      if (connectedRef.current) return;
      connect();
    };
    const onPageShow = (e) => {
      if (!e.persisted || !vmNameRef.current || !viewportRef?.current) return;
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
          className="ml-2 rounded border border-surface-border px-2 py-1 text-xs hover:bg-surface"
        >
          Retry
        </button>
      </div>
    );
  }
  return null;
}
