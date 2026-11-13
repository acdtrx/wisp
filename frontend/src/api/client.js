// Cookie-based session — the JWT lives in an HttpOnly cookie (`wisp_session`)
// the backend sets on /api/auth/login. JS never reads or stores it. The
// non-HttpOnly `wisp_csrf` cookie holds the per-session CSRF token; we read
// it here and echo it as `X-CSRF-Token` on state-changing requests
// (double-submit). On 401 we treat the session as gone and redirect to
// /login. Multi-tab sync is done via a localStorage `wisp_logout` flag the
// authStore writes on logout.
const CSRF_COOKIE = 'wisp_csrf';
const CSRF_HEADER = 'X-CSRF-Token';
const LOGOUT_SIGNAL_KEY = 'wisp_logout';

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function readCsrfToken() {
  if (typeof document === 'undefined') return null;
  for (const part of document.cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name !== CSRF_COOKIE) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

export function isAuthenticated() {
  return readCsrfToken() !== null;
}

/** Shown wherever a request never reached the server. Wisp is usually only
 *  reachable over a VPN, so that is the first thing worth checking. */
export const NETWORK_ERROR_MESSAGE = 'Can’t reach Wisp. Check your VPN or network connection.';

/**
 * True when the request never reached the server — DNS failure, connection
 * refused, connection timed out, VPN down. `fetch()` rejects with a `TypeError`
 * in exactly those cases; every error `api()` raises from an HTTP response
 * carries a numeric `status` instead.
 */
export function isNetworkError(err) {
  return err instanceof TypeError;
}

/**
 * Where a deliberate sign-out lands. The `?sso=signedout` marker stops the
 * login page from auto-redirecting to the SSO provider — with a live provider
 * session that redirect would sign the user straight back in.
 */
export const SIGNED_OUT_LOGIN_PATH = '/login?sso=signedout';

/**
 * Tell the other tabs the session is gone. `reason` is `'signedout'` for a
 * deliberate sign-out (other tabs land on SIGNED_OUT_LOGIN_PATH, no SSO
 * auto-redirect) or `'expired'` for a 401 (plain /login, which may SSO back in).
 */
export function broadcastLogout(reason = 'expired') {
  try {
    if (typeof window !== 'undefined') {
      localStorage.setItem(LOGOUT_SIGNAL_KEY, `${reason}:${Date.now()}`);
    }
  } catch {
    /* ignore — multi-tab logout is best-effort */
  }
}

// Multi-tab logout: when one tab calls broadcastLogout the other tabs see
// the storage event and bounce to the login page. Without this, an authed tab
// would keep using its (already-cleared) session cookie until the next 401.
// A tab already on the login page stays put — re-navigating it could undo a
// sign-out's no-auto-SSO marker.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== LOGOUT_SIGNAL_KEY || !e.newValue) return;
    if (window.location.pathname === '/login') return;
    window.location.href = e.newValue.startsWith('signedout:') ? SIGNED_OUT_LOGIN_PATH : '/login';
  });
}

/**
 * Default deadline for one REST call (CODING-RULES §6), over the request and
 * reading its body. Long operations run as background jobs; the slowest
 * synchronous routes are bounded on the server at 30 s (mounts, the update
 * check) and 2 min (a libvirt start), so 60 s lets their own error arrive.
 * Pass `timeoutMs` for a call that needs another bound.
 */
export const API_TIMEOUT_MS = 60_000;

/** `signals` combined: aborts with the first one's reason (AbortSignal.any where available). */
export function anySignal(signals) {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}

/** The error for a call that hit its own deadline (not the caller's abort). */
function timeoutError(timeoutMs) {
  const err = new Error(`Wisp did not answer within ${Math.round(timeoutMs / 1000)} s`);
  err.name = 'TimeoutError';
  err.code = 'TIMEOUT';
  return err;
}

export async function api(path, options = {}) {
  const { timeoutMs = API_TIMEOUT_MS, signal: callerSignal, ...fetchOptions } = options;
  const method = (fetchOptions.method || 'GET').toUpperCase();
  const headers = { ...fetchOptions.headers };

  if (STATE_CHANGING_METHODS.has(method)) {
    const csrf = readCsrfToken();
    if (csrf) headers[CSRF_HEADER] = csrf;
  }

  if (fetchOptions.body && typeof fetchOptions.body === 'object' && !(fetchOptions.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    fetchOptions.body = JSON.stringify(fetchOptions.body);
  }

  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal ? anySignal([callerSignal, deadline]) : deadline;
  const ownDeadline = (err) => (deadline.aborted && !callerSignal?.aborted ? timeoutError(timeoutMs) : err);

  let res;
  try {
    res = await fetch(path, { ...fetchOptions, headers, credentials: 'include', signal });
  } catch (err) {
    throw ownDeadline(err);
  }

  if (res.status === 401) {
    broadcastLogout();
    window.location.href = '/login';
    throw new Error('Session expired');
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    if (deadline.aborted && !callerSignal?.aborted) throw timeoutError(timeoutMs);
    const msg = data.error || data.message || `Request failed: ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.code = data.code;
    err.detail = data.detail;
    throw err;
  }

  if (res.headers.get('content-type')?.includes('application/json')) {
    try {
      return await res.json();
    } catch (err) {
      throw ownDeadline(err);
    }
  }

  return res;
}
