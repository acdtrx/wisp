import { api } from './client.js';

export function changePassword(currentPassword, newPassword) {
  return api('/api/auth/change-password', {
    method: 'POST',
    body: { currentPassword, newPassword },
  });
}

// Public endpoint — tells the login page whether SSO is configured. Uses a bare
// fetch (not `api`) so it works before any session exists and never triggers the
// 401 → /login redirect in the shared client.
export async function getOidcStatus() {
  try {
    const res = await fetch('/api/auth/oidc/status', { credentials: 'include' });
    if (!res.ok) return { enabled: false };
    return await res.json();
  } catch {
    return { enabled: false };
  }
}

// SSO start is a full-page navigation (the backend 302s to the provider), not a
// fetch — the browser must follow the cross-origin redirect itself.
export const OIDC_LOGIN_URL = '/api/auth/oidc/login';

