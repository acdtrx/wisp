import { create } from 'zustand';

import { errorText } from '../api/errors.js';
import { assertTopic, reconnectEvents, subscribeTopic } from '../api/events.js';
import { openStream } from '../api/sse.js';

/** A stream's error frame: Wisp's error body `{ error, detail }` in place of the payload. */
export function isErrorFrame(frame) {
  return frame != null && typeof frame === 'object' && !Array.isArray(frame) && typeof frame.error === 'string';
}

/**
 * A topic of the shared events stream as a store's source. Its last frame is kept by
 * the events client while any store follows the stream, so a store that disconnects
 * keeps its data: the next connect is answered with the topic's current frame.
 */
export function topicSource(topic) {
  assertTopic(topic);
  return {
    open: ({ onFrame, onDown }) => subscribeTopic(topic, onFrame, onDown),
    retry: () => reconnectEvents(),
    scoped: false,
  };
}

/** A scoped stream as a store's source; `url` takes `connect`'s arguments (its subject),
 *  so a store that disconnects is cleared: the next connect may be for another one. */
export function streamSource(url) {
  return {
    open: ({ onFrame, onDown }, ...args) => openStream(url(...args), onFrame, { onDown }),
    scoped: true,
  };
}

/** A stream's connection: `connecting` until it answers (and while it reconnects after a
 *  retry), `open` while frames come, `dropped` once the connection broke (the client
 *  reconnects), `refused` once Wisp refused the stream, which ended it. */
export const CONNECTION = Object.freeze({ CONNECTING: 'connecting', OPEN: 'open', DROPPED: 'dropped', REFUSED: 'refused' });

/** A store's data while its stream runs and its last gather succeeded, else null:
 *  what a view shows as live (the stats bars). */
export function liveData(state) {
  return state.connection === CONNECTION.OPEN && !state.error ? state.data : null;
}

/**
 * The one way a store mirrors a stream (a topic of the events stream, or a scoped
 * stream): `connect(...args)` opens it, `disconnect()` closes it, `retry()` asks the
 * server again (the events stream reconnects, every topic with it), `dismissError()`
 * puts away an error shown over the data. Each store has one
 * component that connects it, so neither counts its callers. Every such store holds:
 *
 * - `data` — what the last good frame brought (`empty` before one, after a refusal,
 *   and after a scoped stream's disconnect);
 * - `connection` — a `CONNECTION`;
 * - `error` — the text of the last error frame (the gather failed; `data` keeps the
 *   last good payload) or of the refusal, until a good frame; a drop keeps both.
 *
 * @param {object} spec
 * @param {{ open: Function, retry?: Function, scoped: boolean }} spec.source —
 *   `topicSource(topic)` or `streamSource(url)`
 * @param {(frame: any) => any} [spec.toData] — the data a good frame brings;
 *   `undefined` skips a frame that is not one
 * @param {any} [spec.empty] — the data before the first frame (default `null`)
 * @param {(data: any, set: Function, get: Function) => void} [spec.onData] — runs
 *   whenever `data` changes (a good frame, a refusal, a scoped stream's disconnect)
 * @param {(set: Function, get: Function) => object} [spec.extend] — the store's own
 *   state and actions
 */
export function createStreamStore({ source, toData = (frame) => frame, empty = null, onData, extend }) {
  return create((set, get) => {
    const own = extend?.(set, get) ?? {};
    let close = null;
    let openedWith = [];
    const cleared = { data: empty, connection: CONNECTION.CONNECTING, error: null };

    function changeData(next) {
      set(next);
      onData?.(next.data, set, get);
    }

    function onFrame(frame) {
      if (isErrorFrame(frame)) {
        set({ connection: CONNECTION.OPEN, error: errorText(frame) });
        return;
      }
      const data = toData(frame);
      if (data === undefined) return;
      changeData({ data, connection: CONNECTION.OPEN, error: null });
    }

    function onDown(refusal) {
      if (!refusal) {
        set({ connection: CONNECTION.DROPPED });
        return;
      }
      changeData({ data: empty, connection: CONNECTION.REFUSED, error: errorText(refusal) });
    }

    function open(args) {
      openedWith = args;
      close = source.open({ onFrame, onDown }, ...args);
    }

    function shut() {
      const closing = close;
      close = null;
      closing?.();
    }

    const base = {
      ...cleared,

      connect: (...args) => {
        if (close) return;
        open(args);
      },

      disconnect: () => {
        if (!close) return;
        shut();
        if (source.scoped) changeData(cleared);
        else set({ connection: CONNECTION.CONNECTING });
      },

      /** Put away the error shown over the data (the next error frame brings it back). */
      dismissError: () => set({ error: null }),

      retry: () => {
        if (!close) return;
        set({ connection: CONNECTION.CONNECTING });
        if (source.retry) {
          source.retry();
          return;
        }
        shut();
        open(openedWith);
      },
    };
    /* The base owns its names: a store's own state or action may not replace one. */
    for (const name of Object.keys(own)) {
      if (name in base) throw new Error(`A stream store's extend may not redefine "${name}"`);
    }
    return { ...base, ...own };
  });
}
