/**
 * Build WebSocket URL for console endpoints. Auth flows via the same
 * `wisp_session` cookie used for normal API requests — browsers send
 * cookies on same-origin WebSocket upgrades natively, so no `?token=` is
 * appended (the backend's auth hook validates the cookie just like for HTTP).
 */
export function consoleWsUrl(path) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  return `${protocol}//${host}${path}`;
}
