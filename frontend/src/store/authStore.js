import { create } from 'zustand';

import { api, isAuthenticated, broadcastLogout, isNetworkError, NETWORK_ERROR_MESSAGE, API_TIMEOUT_MS } from '../api/client';
import { errorFromBody } from '../api/errors.js';
import { records } from './records.js';

export const useAuthStore = create((set) => ({
  // Cookie-based session — the HttpOnly session cookie is invisible to JS.
  // We track auth status via the (non-HttpOnly) wisp_csrf cookie's presence.
  authenticated: isAuthenticated(),

  /** Sign in with the password: resolves once the session cookies are set, rejects
   *  with the reason (the login page's command hook holds busy and the error). */
  login: async (password) => {
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
        credentials: 'include',
        signal: AbortSignal.timeout(API_TIMEOUT_MS), // CODING-RULES §6
      });

      if (!res.ok) {
        throw errorFromBody(await res.json().catch(() => null /* no JSON body: the error is made from the status */), res.status);
      }

      // Cookies are now set by the response (HttpOnly session + CSRF).
      set({ authenticated: true });
    } catch (err) {
      // A dead VPN surfaces here as fetch's bare "Load failed" — name the actual cause.
      // TimeoutError is the platform's name for AbortSignal.timeout firing.
      const timedOut = err?.name === 'TimeoutError';
      if (isNetworkError(err) || timedOut) throw new Error(NETWORK_ERROR_MESSAGE, { cause: err });
      throw err;
    }
  },

  logout: async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      /* logout is best-effort — even on failure clear local state */
    }
    broadcastLogout('signedout');
    records.clear();
    set({ authenticated: false });
  },
}));
