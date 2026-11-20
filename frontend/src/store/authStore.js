import { create } from 'zustand';
import { api, isAuthenticated, broadcastLogout, isNetworkError, NETWORK_ERROR_MESSAGE, API_TIMEOUT_MS } from '../api/client';
import { errorFromBody, errorText } from '../api/errors.js';

export const useAuthStore = create((set) => ({
  // Cookie-based session — the HttpOnly session cookie is invisible to JS.
  // We track auth status via the (non-HttpOnly) wisp_csrf cookie's presence.
  authenticated: isAuthenticated(),
  error: null,
  loading: false,

  login: async (password) => {
    set({ loading: true, error: null });
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
        credentials: 'include',
        signal: AbortSignal.timeout(API_TIMEOUT_MS), // CODING-RULES §6
      });

      if (!res.ok) {
        throw errorFromBody(await res.json().catch(() => null), res.status);
      }

      // Cookies are now set by the response (HttpOnly session + CSRF).
      set({ authenticated: true, loading: false });
      return true;
    } catch (err) {
      // A dead VPN surfaces here as fetch's bare "Load failed" — name the actual cause.
      // TimeoutError is the platform's name for AbortSignal.timeout firing.
      const timedOut = err?.name === 'TimeoutError';
      set({ error: isNetworkError(err) || timedOut ? NETWORK_ERROR_MESSAGE : errorText(err), loading: false });
      return false;
    }
  },

  logout: async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      /* logout is best-effort — even on failure clear local state */
    }
    broadcastLogout('signedout');
    set({ authenticated: false });
  },
}));
