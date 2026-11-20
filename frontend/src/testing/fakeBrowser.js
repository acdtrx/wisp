/**
 * Browser stand-ins for the unit tests (`npm test`, node:test under plain Node):
 * `window`, `document` and `localStorage` as far as the client's api and SSE
 * modules touch them, and a `fetch` whose every request the test answers by hand,
 * with SSE bodies it writes into chunk by chunk. Never imported by the app.
 */

/** How long `next()` waits for a request before it fails the test. Real time,
 *  so the timers the tests mock do not stop it. */
const NEXT_REQUEST_MS = 2000;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

/** A Storage stand-in over a Map. */
function fakeStorage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
}

/** Install fresh `window`, `document`, `localStorage` and `sessionStorage` globals; returns them. */
export function installBrowser() {
  const events = { addEventListener() {}, removeEventListener() {} };
  const window = { location: { href: '', pathname: '/' }, ...events };
  const document = { visibilityState: 'visible', cookie: '', ...events };
  const localStorage = fakeStorage();
  const sessionStorage = fakeStorage();
  // defineProperty: Node may already own a read-only `localStorage` global.
  for (const [name, value] of Object.entries({ window, document, localStorage, sessionStorage })) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  return { window, document, localStorage, sessionStorage };
}

/**
 * Replace `fetch`: each call becomes a pending request the test answers with
 * `request.respond(response)`. An aborted request rejects with an AbortError,
 * as the platform's does.
 */
export function installFetch() {
  const requests = [];
  const waiting = [];
  const prefix = (url) => ({ test: (u) => u.startsWith(url), label: `${url}…` });
  const exact = (url) => ({ test: (u) => u === url, label: url });

  globalThis.fetch = (url, options = {}) => new Promise((resolve, reject) => {
    const request = { url: String(url), signal: options.signal, taken: false, respond: resolve };
    options.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
    requests.push(request);
    const waiter = waiting.find((w) => w.match.test(request.url));
    if (waiter) {
      request.taken = true;
      waiting.splice(waiting.indexOf(waiter), 1);
      waiter.resolve(request);
    }
  });

  /** The oldest matching request not taken yet; waits for one, and fails after
   *  NEXT_REQUEST_MS naming the URL it waited for. */
  const take = (match) => {
    const ready = requests.find((r) => !r.taken && match.test(r.url));
    if (ready) {
      ready.taken = true;
      return Promise.resolve(ready);
    }
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve: (request) => { realClearTimeout(timer); resolve(request); } };
      const timer = realSetTimeout(() => {
        waiting.splice(waiting.indexOf(waiter), 1);
        reject(new Error(`no request to ${match.label} within ${NEXT_REQUEST_MS / 1000} s`));
      }, NEXT_REQUEST_MS);
      waiting.push(waiter);
    });
  };

  return {
    /** Requests whose URL starts with `url`. */
    made: (url) => requests.filter((r) => r.url.startsWith(url)),
    /** The next request whose URL starts with `url`. */
    next: (url) => take(prefix(url)),
    /** The next request to exactly `url`. */
    nextExact: (url) => take(exact(url)),
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
