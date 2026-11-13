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

/**
 * Close `ws` if it hasn't opened within `ms` (CODING-RULES §6, TMO-17): a
 * WebSocket has no connect timeout of its own, and a half-open network leaves it
 * CONNECTING for minutes. The close then takes the console's usual retry path.
 */
export const WS_CONNECT_TIMEOUT_MS = 15_000;

export function closeIfNotOpenWithin(ws, ms = WS_CONNECT_TIMEOUT_MS) {
  const timer = setTimeout(() => {
    if (ws.readyState === WebSocket.CONNECTING) ws.close();
  }, ms);
  const clear = () => clearTimeout(timer);
  ws.addEventListener('open', clear, { once: true });
  ws.addEventListener('close', clear, { once: true });
}
