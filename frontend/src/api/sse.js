import { broadcastLogout } from './client.js';

/** Long-lived SSE (`createSSE`): reconnect delays */
const SSE_INITIAL_RETRY_MS = 1000;
const SSE_MAX_RETRY_MS = 30000;
/** Max time to wait for response headers/body on a single fetch attempt */
const SSE_FETCH_TIMEOUT_MS = 90_000;

function sseBackoffMs(previousMs) {
  const cap = Math.min(previousMs * 2, SSE_MAX_RETRY_MS);
  const jitter = cap * 0.15 * Math.random();
  return Math.round(Math.min(cap * 0.85 + jitter, SSE_MAX_RETRY_MS));
}

function withJitterMs(baseMs) {
  const jitter = baseMs * 0.1 * Math.random();
  return Math.round(baseMs * 0.95 + jitter);
}

/**
 * One-shot job progress SSE. Auth flows via the wisp_session cookie (sent
 * automatically by the browser on same-origin fetches with credentials).
 * Reconnects with backoff until terminal `done`/`error` or job missing (404).
 * Server replays buffered events on reconnect.
 *
 * @param {(ev: object) => void} onMessage
 * @param {(reason?: 'not_found') => void} [onConnectionLost] — 404 passes `not_found` (job expired / unknown)
 */
export function createJobSSE(url, onMessage, onConnectionLost) {
  let closed = false;
  let retryTimer = null;
  let retryDelay = SSE_INITIAL_RETRY_MS;
  let controller = null;

  function clearRetry() {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  async function connect() {
    if (closed) return;

    try {
      controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), SSE_FETCH_TIMEOUT_MS);
      const res = await fetch(url, { signal: controller.signal, credentials: 'include' });
      clearTimeout(tid);

      if (res.status === 401) {
        broadcastLogout();
        window.location.href = '/login';
        return;
      }

      if (res.status === 404) {
        closed = true;
        onConnectionLost?.('not_found');
        return;
      }

      if (!res.ok || !res.body) {
        throw new Error(`Job SSE failed: ${res.status}`);
      }

      retryDelay = SSE_INITIAL_RETRY_MS;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              onMessage(data);
              if (data.step === 'done' || data.step === 'error') {
                closed = true;
                clearRetry();
                return;
              }
            } catch {
              /* Ignore malformed SSE message */
            }
          }
        }
      }

      if (!closed) {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          connect();
        }, withJitterMs(retryDelay));
        retryDelay = sseBackoffMs(retryDelay);
      }
    } catch (err) {
      if (closed || err.name === 'AbortError') return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        retryDelay = sseBackoffMs(retryDelay);
        connect();
      }, withJitterMs(retryDelay));
    }
  }

  connect();

  return function close() {
    closed = true;
    clearRetry();
    if (controller) {
      controller.abort();
      controller = null;
    }
  };
}

export function createSSE(url, onMessage, onError) {
  let retryDelay = SSE_INITIAL_RETRY_MS;
  let retryTimer = null;
  let closed = false;
  let controller = null;

  function clearRetry() {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  async function connect() {
    if (closed) return;

    try {
      controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), SSE_FETCH_TIMEOUT_MS);
      const res = await fetch(url, { signal: controller.signal, credentials: 'include' });
      clearTimeout(tid);

      if (res.status === 401) {
        broadcastLogout();
        window.location.href = '/login';
        return;
      }

      if (!res.ok || !res.body) {
        throw new Error(`SSE request failed: ${res.status}`);
      }

      retryDelay = SSE_INITIAL_RETRY_MS;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              onMessage(data);
            } catch {
              /* Ignore malformed SSE message */
            }
          }
        }
      }

      if (!closed) {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          connect();
        }, withJitterMs(retryDelay));
        retryDelay = sseBackoffMs(retryDelay);
      }
    } catch (err) {
      if (closed || err.name === 'AbortError') return;
      if (onError) onError();
      retryTimer = setTimeout(() => {
        retryTimer = null;
        retryDelay = sseBackoffMs(retryDelay);
        connect();
      }, withJitterMs(retryDelay));
    }
  }

  connect();

  return function close() {
    closed = true;
    clearRetry();
    if (controller) {
      controller.abort();
      controller = null;
    }
  };
}
