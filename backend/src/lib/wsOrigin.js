/**
 * Origin check for WebSocket upgrade requests. CORS does not apply to WS, so
 * without this an attacker page on any origin can open a WS to /ws/console/...
 * and (combined with a stolen JWT) drive the VM's VNC. Refusing connections
 * whose Origin header doesn't match the served frontend closes that gap.
 *
 * Dev: only http://localhost:5173 (Vite dev server).
 * Prod: same-origin only — Origin's host must equal the request Host header.
 *       Frontends served from a different origin would need an explicit
 *       allow-list via WISP_ALLOWED_WS_ORIGINS (comma-separated).
 *
 * Returns true if the origin is allowed; false otherwise.
 */
const DEV_ORIGINS = new Set(['http://localhost:5173']);

function getExtraAllowedOrigins() {
  const raw = process.env.WISP_ALLOWED_WS_ORIGINS;
  if (!raw) return null;
  const set = new Set();
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed) set.add(trimmed);
  }
  return set.size > 0 ? set : null;
}

export function isAllowedWsOrigin(req) {
  const origin = req.headers?.origin;
  if (!origin) return false;

  if (process.env.NODE_ENV === 'development' && DEV_ORIGINS.has(origin)) return true;

  const extras = getExtraAllowedOrigins();
  if (extras && extras.has(origin)) return true;

  // Same-origin: parse the Origin URL and compare its host to the Host header.
  const host = req.headers?.host;
  if (!host) return false;
  let parsedHost;
  try {
    parsedHost = new URL(origin).host;
  } catch {
    return false;
  }
  return parsedHost === host;
}
