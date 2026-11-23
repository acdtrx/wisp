import { leaveForLogin } from './client.js';
import { errorFromBody, isSessionLost } from './errors.js';

/** Reconnect delays */
const SSE_INITIAL_RETRY_MS = 1000;
const SSE_MAX_RETRY_MS = 30000;
/** Max time to wait for response headers/body on a single fetch attempt */
const SSE_FETCH_TIMEOUT_MS = 90_000;
/** Max gap between any bytes (real event or `: keepalive` comment) before we treat
 *  the stream as dead and reconnect. Backend writes a keepalive every 25s in
 *  setupSSE; this catches silently-dropped TCP (NAT expiry, server crash) where
 *  reader.read() would otherwise block forever. */
const SSE_READ_IDLE_MS = 60_000;

/** A stream that has produced no bytes for longer than the backend's 25s keepalive is
 *  dead, not idle. `resync` uses this to tell a suspended-and-resumed connection from a
 *  healthy one, so a desktop tab switch doesn't tear down a stream that is still fed. */
const SSE_STALE_MS = 30_000;

/**
 * Wire the two events that mean "this stream may have died while we weren't watching":
 * the page returning to the foreground, and the network coming back. Returns a detach
 * function. Callers decide in `resync` whether a reconnect is actually warranted.
 *
 * iOS freezes a backgrounded home-screen app's JS context. The socket dies with it, but
 * neither the read watchdog nor the retry timer can run while frozen — so on resume the
 * app would otherwise keep rendering whatever it had at suspend time until the watchdog
 * and backoff elapse. These are real signals, not polling: nothing fires on a timer.
 */
function onResumeOrReconnect(resync) {
  const onVisible = () => {
    if (document.visibilityState === 'visible') resync();
  };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', resync);
  return () => {
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', resync);
  };
}

function sseBackoffMs(previousMs) {
  const cap = Math.min(previousMs * 2, SSE_MAX_RETRY_MS);
  const jitter = cap * 0.15 * Math.random();
  return Math.round(Math.min(cap * 0.85 + jitter, SSE_MAX_RETRY_MS));
}

function withJitterMs(baseMs) {
  const jitter = baseMs * 0.1 * Math.random();
  return Math.round(baseMs * 0.95 + jitter);
}

/** Wisp's error body, `{ error: <code>, detail }`: an answer Wisp gave. A 4xx
 *  without it (a proxy's 401 or 403, an HTML page) is not Wisp's. */
function isWispErrorBody(body) {
  return typeof body?.error === 'string' && body.error !== '' && typeof body.detail === 'string';
}

/**
 * What a stream's failed answer means
 * (docs/specs/ERROR-HANDLING.md, Stream refusals): a lost session leaves for
 * the login page; any other 4xx carrying Wisp's error body ends the stream
 * with its error, since asking Wisp again gets the same refusal; a 5xx, an
 * answer that is not Wisp's (a proxy's page), or one with no body is retried
 * like a lost connection.
 * @returns {Promise<{ err: import('./errors.js').ApiError, end: 'session' | 'refused' | 'retry' }>}
 */
async function failedAnswer(res) {
  const body = await res.json().catch(() => null /* no JSON body: not Wisp's answer, retried below */);
  const err = errorFromBody(body, res.status);
  if (!isWispErrorBody(body)) return { err, end: 'retry' };
  if (isSessionLost(err)) return { err, end: 'session' };
  return { err, end: res.status >= 400 && res.status < 500 ? 'refused' : 'retry' };
}

/**
 * The one SSE client, for the events stream, the scoped streams and job
 * progress alike. Auth flows via the wisp_session cookie (sent by the browser
 * on same-origin fetches with credentials). It reconnects with backoff after a
 * lost connection, a 5xx or an answer that is not Wisp's, until it is closed,
 * Wisp refuses it (`failedAnswer`), or a frame `endsAt` matches: that frame is
 * the stream's last (a job's terminal event; the server ends the response
 * after it). A lost session sends the user to sign in.
 *
 * @param {string} url
 * @param {(frame: any) => void} onFrame - each `data:` frame, parsed
 * @param {{
 *   onDown?: (refusal?: import('./errors.js').ApiError) => void,
 *   endsAt?: (frame: any) => boolean,
 * }} [options] - `onDown()` with nothing: the connection dropped, and the
 *   client reconnects; `onDown(err)`: Wisp refused the stream with a 4xx, which
 *   ended it (a 404: its subject is gone)
 * @returns {() => void} close
 */
export function openStream(url, onFrame, { onDown, endsAt } = {}) {
  let closed = false;
  let retryTimer = null;
  let retryDelay = SSE_INITIAL_RETRY_MS;
  let controller = null;
  /** When the stream last proved it was alive. Seeded at each connect so an
   *  in-flight fetch that hasn't answered yet still counts fresh. */
  let lastByteAt = Date.now();
  /** Reassigned once the listeners are attached, below. Terminal paths detach through it. */
  let detachResync = () => {};

  function clearRetry() {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  /** Stop for good: no further reconnects, no lingering resume listeners. */
  function finish() {
    closed = true;
    clearRetry();
    detachResync();
  }

  async function connect() {
    if (closed) return;

    lastByteAt = Date.now();
    // Capture controller in this closure so the timeout / catch don't see a
    // stale outer reference that close() may have nulled in the meantime.
    const myController = new AbortController();
    controller = myController;
    const tid = setTimeout(() => myController.abort(), SSE_FETCH_TIMEOUT_MS);
    let watchdog = null;
    const armWatchdog = () => {
      lastByteAt = Date.now();
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => myController.abort(), SSE_READ_IDLE_MS);
    };
    const clearWatchdog = () => {
      if (watchdog) { clearTimeout(watchdog); watchdog = null; }
    };

    try {
      const res = await fetch(url, { signal: myController.signal, credentials: 'include' });
      clearTimeout(tid);

      if (!res.ok || !res.body) {
        const { err, end } = await failedAnswer(res);
        if (end === 'session') {
          leaveForLogin(err);
          return;
        }
        // Refused: asking again gets the same answer. Stop, and say why.
        if (end === 'refused') {
          finish();
          onDown?.(err);
          return;
        }
        throw err;
      }

      retryDelay = SSE_INITIAL_RETRY_MS;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      armWatchdog();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        armWatchdog();

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const frame = JSON.parse(line.slice(6));
            onFrame(frame);
            if (endsAt?.(frame)) {
              finish();
              return;
            }
          } catch {
            /* A malformed frame, or one its handler throws on, is skipped: one bad
             * frame never drops the stream. */
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
    } catch {
      clearTimeout(tid);
      // Treat any abort while open as a dead connection — could be the read
      // watchdog, the initial fetch timeout, or a network drop. close() flips
      // `closed` before aborting, so user-initiated teardowns short-circuit here.
      if (closed) return;
      onDown?.();
      retryTimer = setTimeout(() => {
        retryTimer = null;
        retryDelay = sseBackoffMs(retryDelay);
        connect();
      }, withJitterMs(retryDelay));
    } finally {
      clearTimeout(tid);
      clearWatchdog();
    }
  }

  /** Called when the app is foregrounded or the network returns — see onResumeOrReconnect.
   *  A job's stream catches up too: the server replays its events on reconnect. */
  function resync() {
    if (closed) return;
    if (retryTimer) {
      // Already known dead and counting down (up to SSE_MAX_RETRY_MS). Don't wait it out:
      // the two events that call us are exactly when the server tends to be reachable again.
      clearRetry();
      retryDelay = SSE_INITIAL_RETRY_MS;
      connect();
      return;
    }
    if (Date.now() - lastByteAt < SSE_STALE_MS) return; // keepalives still landing; leave it be
    // Abort the corpse; the read loop's catch owns the reconnect from here, one delay later.
    retryDelay = SSE_INITIAL_RETRY_MS;
    controller?.abort();
  }

  connect();
  detachResync = onResumeOrReconnect(resync);

  return function close() {
    finish();
    if (controller) {
      controller.abort();
      controller = null;
    }
  };
}
