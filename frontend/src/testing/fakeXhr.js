/**
 * An `XMLHttpRequest` stand-in for the unit tests (`npm test`, node:test under
 * plain Node), as far as the upload client touches it. Every request waits for
 * the test to drive it: upload progress, the body sent, the answer, a network
 * error or an abort, each firing its events in the platform's order. Never
 * imported by the app.
 */

/** A minimal event target: `addEventListener` and a `fire` for the stand-in. */
function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    fire(type, event = {}) {
      for (const fn of listeners.get(type) ?? []) fn({ type, ...event });
    },
  };
}

/** Install a fresh `XMLHttpRequest` global; returns the requests made through it. */
export function installXhr() {
  const requests = [];

  class FakeXMLHttpRequest {
    constructor() {
      Object.assign(this, eventTarget());
      this.upload = eventTarget();
      this.method = null;
      this.url = null;
      this.headers = {};
      this.body = undefined;
      this.status = 0;
      this.responseText = '';
      this.done = false;
      requests.push(this);
    }

    open(method, url) {
      this.method = method;
      this.url = url;
    }

    setRequestHeader(name, value) {
      this.headers[name] = value;
    }

    send(body) {
      this.body = body;
    }

    /** The browser, or the page, cancels the request. */
    abort() {
      if (this.done) return;
      this.done = true;
      this.fire('abort');
      this.fire('loadend');
    }

    /** Test: `loaded` of `total` bytes sent. */
    progress(loaded, total) {
      this.upload.fire('progress', { lengthComputable: true, loaded, total });
    }

    /** Test: the whole body sent; the reply is awaited. */
    bodySent() {
      this.upload.fire('load');
    }

    /** Test: the server answers `status` with `body` (a string, or JSON-encoded). */
    respond(status, body = '') {
      this.done = true;
      this.status = status;
      this.responseText = typeof body === 'string' ? body : JSON.stringify(body);
      this.fire('load');
      this.fire('loadend');
    }

    /** Test: the request never reaches the server. */
    networkError() {
      this.done = true;
      this.fire('error');
      this.fire('loadend');
    }
  }

  globalThis.XMLHttpRequest = FakeXMLHttpRequest;
  return {
    requests,
    /** The latest request made. */
    last: () => requests.at(-1),
  };
}
