const TOKEN_KEY = 'wisp_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export async function api(path, options = {}) {
  const token = getToken();
  const headers = { ...options.headers };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }

  const res = await fetch(path, { ...options, headers });

  if (res.status === 401) {
    clearToken();
    window.location.href = '/login';
    throw new Error('Session expired');
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const msg = data.message || data.error || `Request failed: ${res.status}`;
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
