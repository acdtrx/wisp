import { create } from 'zustand';
import { api, getToken, setToken, clearToken } from '../api/client';

export const useAuthStore = create((set) => ({
  token: getToken(),
  error: null,
  loading: false,

  login: async (password) => {
    set({ loading: true, error: null });
    try {
      const data = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });

      if (!data.ok) {
        const body = await data.json().catch(() => ({}));
        throw new Error(body.error || 'Login failed');
      }

      const { token } = await data.json();
      setToken(token);
      set({ token, loading: false });
      return true;
    } catch (err) {
      set({ error: err.message, loading: false });
      return false;
    }
  },

  logout: () => {
    clearToken();
    set({ token: null });
  },
}));
