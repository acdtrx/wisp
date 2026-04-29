import { useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthStore } from '../../store/authStore';
import { api } from '../../api/client';

const CHECK_INITIAL_DELAY_MS = 0;
const CHECK_MAX_DELAY_MS = 5000;

export default function ProtectedRoute({ children }) {
  const authenticated = useAuthStore((s) => s.authenticated);
  const [checked, setChecked] = useState(false);
  const retryTimer = useRef(null);

  useEffect(() => {
    if (!authenticated) return;

    let cancelled = false;
    let delay = CHECK_INITIAL_DELAY_MS;

    function attempt() {
      api('/api/host')
        .then(() => { if (!cancelled) setChecked(true); })
        .catch((err) => {
          // api() already handles 401 by redirecting to /login
          if (cancelled || err.message === 'Session expired') return;
          // Non-auth error (e.g. 503 during service restart): retry with backoff
          const next = Math.min(delay === 0 ? 1000 : delay * 2, CHECK_MAX_DELAY_MS);
          delay = next;
          retryTimer.current = setTimeout(() => {
            retryTimer.current = null;
            attempt();
          }, next);
        });
    }

    attempt();

    return () => {
      cancelled = true;
      if (retryTimer.current) {
        clearTimeout(retryTimer.current);
        retryTimer.current = null;
      }
    };
  }, [authenticated]);

  if (!authenticated) {
    return <Navigate to="/login" replace />;
  }

  if (!checked) {
    return null;
  }

  return children;
}
