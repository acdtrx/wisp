import { getToken } from './client.js';

/**
 * Build WebSocket URL for console endpoints. Uses current host and appends token for auth.
 */
export function consoleWsUrl(path, token = getToken()) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  const sep = path.includes('?') ? '&' : '?';
  const tokenPart = token ? `${sep}token=${encodeURIComponent(token)}` : '';
  return `${protocol}//${host}${path}${tokenPart}`;
}
