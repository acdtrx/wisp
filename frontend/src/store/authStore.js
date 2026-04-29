import { create } from 'zustand';
import { api, isAuthenticated, broadcastLogout } from '../api/client';

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
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Login failed');
      }

      // Cookies are now set by the response (HttpOnly session + CSRF).
      set({ authenticated: true, loading: false });
      return true;
    } catch (err) {
      set({ error: err.message, loading: false });
      return false;
    }
  },

  logout: async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      /* logout is best-effort — even on failure clear local state */
    }
    broadcastLogout();
    set({ authenticated: false });
  },
}));
