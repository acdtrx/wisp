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

export function broadcastLogout() {
  try {
    if (typeof window !== 'undefined') {
      localStorage.setItem(LOGOUT_SIGNAL_KEY, String(Date.now()));
    }
  } catch {
    /* ignore — multi-tab logout is best-effort */
  }
}

// Multi-tab logout: when one tab calls broadcastLogout the other tabs see
// the storage event and bounce to /login. Without this, an authed tab would
// keep using its (already-cleared) session cookie until the next 401.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === LOGOUT_SIGNAL_KEY && e.newValue) {
      window.location.href = '/login';
    }
  });
}

export async function api(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = { ...options.headers };

  if (STATE_CHANGING_METHODS.has(method)) {
    const csrf = readCsrfToken();
    if (csrf) headers[CSRF_HEADER] = csrf;
  }

  if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }

  const res = await fetch(path, { ...options, headers, credentials: 'include' });

  if (res.status === 401) {
    broadcastLogout();
    window.location.href = '/login';
    throw new Error('Session expired');
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const msg = data.error || data.message || `Request failed: ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.code = data.code;
    err.detail = data.detail;
    throw err;
  }

  if (res.headers.get('content-type')?.includes('application/json')) {
    return res.json();
  }

  return res;
}
