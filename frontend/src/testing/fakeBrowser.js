/**
 * Browser stand-ins for the unit tests (`npm test`, node:test under plain Node):
 * `window`, `document` and `localStorage` as far as the client's api and SSE
 * modules touch them, and a `fetch` whose every request the test answers by hand,
 * with SSE bodies it writes into chunk by chunk. Never imported by the app.
 */

/** Install fresh `window`, `document` and `localStorage` globals; returns them. */
export function installBrowser() {
  const listeners = new Map();
  const on = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
  };
  const off = (type, fn) => listeners.get(type)?.delete(fn);
  const window = {
    location: { href: '', pathname: '/' },
    addEventListener: on,
    removeEventListener: off,
  };
  const document = {
    visibilityState: 'visible',
    cookie: '',
    addEventListener: on,
    removeEventListener: off,
  };
  const store = new Map();
  const localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  // defineProperty: Node may already own a read-only `localStorage` global.
  for (const [name, value] of Object.entries({ window, document, localStorage })) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  return { window, document, localStorage, listeners };
}

/**
 * Replace `fetch`: each call becomes a pending request the test answers with
 * `request.respond(response)` or `request.fail(error)`. An aborted request
 * rejects with an AbortError, as the platform's does.
 */
export function installFetch() {
  const requests = [];
  const waiting = [];
  /** A URL test: a string is a prefix, a function a predicate. */
  const matches = (match, url) => (typeof match === 'function' ? match(url) : url.startsWith(match));

  globalThis.fetch = (url, options = {}) => new Promise((resolve, reject) => {
    const request = {
      url: String(url),
      options,
      signal: options.signal,
      taken: false,
      respond: resolve,
      fail: reject,
    };
    options.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
    requests.push(request);
    for (const w of [...waiting]) {
      if (!request.taken && matches(w.match, request.url)) {
        request.taken = true;
        waiting.splice(waiting.indexOf(w), 1);
        w.resolve(request);
      }
    }
  });

  return {
    requests,
    /** Requests whose URL matches (a string is a prefix, a function a predicate). */
    made: (match) => requests.filter((r) => matches(match, r.url)),
    /** The oldest matching request not taken yet, waiting for one if needed. */
    next(match) {
      const ready = requests.find((r) => !r.taken && matches(match, r.url));
      if (ready) {
        ready.taken = true;
        return Promise.resolve(ready);
      }
      return new Promise((resolve) => waiting.push({ match, resolve }));
    },
  };
}

function abortError() {
  return new DOMException('The operation was aborted.', 'AbortError');
}

/** A JSON response. */
export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * Answer `request` with an SSE body the test writes into: `send(text)` for a raw
 * chunk, `frame(data)` for one `data:` frame, `end()` for the server closing the
 * stream, `drop()` for the connection breaking. Aborting the request breaks the
 * body, as the platform's fetch does.
 */
export function respondWithStream(request) {
  const encoder = new TextEncoder();
  let controller;
  let open = true;
  const body = new ReadableStream({ start(c) { controller = c; } });
  const breakWith = (err) => {
    if (!open) return;
    open = false;
    controller.error(err);
  };
  request.signal?.addEventListener('abort', () => breakWith(abortError()), { once: true });
  request.respond(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
  return {
    send: (text) => controller.enqueue(encoder.encode(text)),
    frame: (data) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)),
    end: () => {
      if (!open) return;
      open = false;
      controller.close();
    },
    drop: () => breakWith(new TypeError('network error')),
  };
}

/** Let pending promise callbacks and stream reads run (timers stay mocked). */
export async function settle() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}
