import { api } from './client.js';

export function listApiTokens({ signal } = {}) {
  return api('/api/auth/tokens', { signal });
}

export function createApiToken(body) {
  return api('/api/auth/tokens', { method: 'POST', body });
}

export function deleteApiToken(id) {
  return api(`/api/auth/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
