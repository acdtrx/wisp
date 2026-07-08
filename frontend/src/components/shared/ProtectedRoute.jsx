import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';

import { useAuthStore } from '../../store/authStore';
import { api, isNetworkError } from '../../api/client';
import FullScreenSpinner from './FullScreenSpinner.jsx';
import ServerUnreachable from './ServerUnreachable.jsx';

// Reconnect backoff for the boot probe. Not a race workaround: the server is
// genuinely absent (VPN down, service restarting) and we wait for it to come back.
const RETRY_INITIAL_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 15000;

/** A dead VPN doesn't refuse the connection, it swallows it — the request hangs
 *  until the OS connect timeout (~75 s on iOS). /api/host answers in milliseconds
 *  when the server is alive, so anything past this is unreachable. A false positive
 *  costs nothing: the screen it shows re-probes a second later and recovers. */
const PROBE_TIMEOUT_MS = 5000;

/** The happy path resolves in a few ms, so hold the spinner back long enough that
 *  it never flashes. Past this, something is slow and the user deserves feedback
 *  rather than an empty page. */
const SPINNER_DELAY_MS = 500;

export default function ProtectedRoute({ children }) {
  const authenticated = useAuthStore((s) => s.authenticated);

  // Kept minimal on purpose: once 'unreachable' is showing, every subsequent probe
  // re-sets identical values, so React bails out and the screen never re-renders.
  // Tracking probe-in-flight state here would flash the Retry button on each tick.
  const [status, setStatus] = useState('checking'); // 'checking' | 'ready' | 'unreachable'
  const [failureKind, setFailureKind] = useState('offline');
  const [showSpinner, setShowSpinner] = useState(false);

  // Only the retry entry point escapes the effect. Everything the probe loop mutates
  // is scoped to one effect run, so a remount can't have a stale probe's cleanup
  // clobber the live one's state.
  const retryRef = useRef(null);

  useEffect(() => {
    if (!authenticated) return;

    let cancelled = false;
    let probing = false;
    let ready = false;
    let delay = RETRY_INITIAL_DELAY_MS;
    let retryTimer = null;
    let controller = null;

    const clearRetry = () => {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    // `probing` collapses overlapping probes — 'online' and 'visibilitychange'
    // routinely fire together, and two in-flight probes would each arm a retry
    // timer, orphaning one and doubling the backoff cadence.
    const probe = async () => {
      if (cancelled || probing) return;
      probing = true;
      clearRetry();

      controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

      try {
        await api('/api/host', { signal: controller.signal });
        if (cancelled) return;
        ready = true;
        delay = RETRY_INITIAL_DELAY_MS;
        setStatus('ready');
      } catch (err) {
        // api() already redirected to /login on 401.
        if (cancelled || err.message === 'Session expired') return;
        // A timeout and a refused connection tell the user the same story: the
        // request never reached a healthy Wisp. Only a real HTTP error is 'server'.
        const neverAnswered = err.name === 'AbortError' || isNetworkError(err);
        setFailureKind(neverAnswered ? 'offline' : 'server');
        setStatus('unreachable');
        retryTimer = setTimeout(probe, delay);
        delay = Math.min(delay * 2, RETRY_MAX_DELAY_MS);
      } finally {
        clearTimeout(timeout);
        probing = false;
      }
    };

    const retryNow = () => {
      delay = RETRY_INITIAL_DELAY_MS;
      probe();
    };
    retryRef.current = retryNow;

    // The VPN reconnecting, and the app being resumed from the iOS app switcher,
    // are the two moments the server is most likely to have become reachable —
    // probe immediately instead of waiting out the backoff. Skip once ready: this
    // gate only guards boot, and a healthy session must not be torn down by a
    // transient failure (the SSE streams handle their own reconnects).
    const probeIfWaiting = () => {
      if (!ready) retryNow();
    };
    const probeOnResume = () => {
      if (document.visibilityState === 'visible') probeIfWaiting();
    };

    probe();
    window.addEventListener('online', probeIfWaiting);
    document.addEventListener('visibilitychange', probeOnResume);

    return () => {
      cancelled = true;
      controller?.abort();
      clearRetry();
      window.removeEventListener('online', probeIfWaiting);
      document.removeEventListener('visibilitychange', probeOnResume);
    };
  }, [authenticated]);

  // Never leave the page blank while a probe drags on.
  useEffect(() => {
    if (status !== 'checking') {
      setShowSpinner(false);
      return;
    }
    const timer = setTimeout(() => setShowSpinner(true), SPINNER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [status]);

  const handleRetry = useCallback(() => retryRef.current?.(), []);

  if (!authenticated) {
    return <Navigate to="/login" replace />;
  }

  if (status === 'unreachable') {
    return <ServerUnreachable kind={failureKind} onRetry={handleRetry} />;
  }

  if (status !== 'ready') {
    return showSpinner ? <FullScreenSpinner /> : null;
  }

  return children;
}
