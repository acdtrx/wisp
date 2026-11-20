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

/** A store's data while its stream runs and its last gather succeeded, else null:
 *  what a view shows as live (the stats bars). */
export function liveData(state) {
  return state.connected && !state.error ? state.data : null;
}

/**
 * The one way a store mirrors a stream (a topic of the events stream, or a scoped
 * stream): `connect(...args)` opens it, `disconnect()` closes it, `retry()` asks the
 * server again (the events stream reconnects, every topic with it). Each store has one
 * component that connects it, so neither counts its callers. Every such store holds:
 *
 * - `data` — what the last good frame brought (`empty` before one, after a refusal,
 *   and after a scoped stream's disconnect);
 * - `connected` — `null` until the stream answers, `true` while frames come, `false`
 *   once the connection dropped (the client reconnects) or Wisp refused the stream;
 * - `error` — the text of the last error frame (the gather failed; `data` keeps the
 *   last good payload) or of the refusal, until a good frame;
 * - `refused` — Wisp refused the stream, which ended it, until `retry()`.
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
    let close = null;
    let openedWith = [];
    const cleared = { data: empty, connected: null, error: null, refused: false };

    function changeData(next) {
      set(next);
      onData?.(next.data, set, get);
    }

    function onFrame(frame) {
      if (isErrorFrame(frame)) {
        set({ connected: true, error: errorText(frame) });
        return;
      }
      const data = toData(frame);
      if (data === undefined) return;
      changeData({ data, connected: true, error: null, refused: false });
    }

    function onDown(refusal) {
      if (!refusal) {
        set({ connected: false });
        return;
      }
      changeData({ data: empty, connected: false, error: errorText(refusal), refused: true });
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

    return {
      ...cleared,
      ...extend?.(set, get),

      connect: (...args) => {
        if (close) return;
        open(args);
      },

      disconnect: () => {
        if (!close) return;
        shut();
        if (source.scoped) changeData(cleared);
        else set({ connected: null });
      },

      retry: () => {
        if (!close) return;
        set({ refused: false });
        if (source.retry) {
          source.retry();
          return;
        }
        shut();
        open(openedWith);
      },
    };
  });
}
