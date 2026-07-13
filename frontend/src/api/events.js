import { createSSE } from './sse.js';

/**
 * Topic subscriptions over the single always-on `/api/events` SSE stream.
 *
 * The server multiplexes every continuously-needed feed (host stats, VM list,
 * container list, sections, discovered peers) as `{ topic, data }` frames on
 * one connection, because browsers cap plain-HTTP/1.1 connections at 6 per
 * origin and each SSE stream holds one for its lifetime — five dedicated
 * streams plus a per-entity stats stream used to exhaust the pool and queue
 * every further fetch indefinitely.
 *
 * One shared connection lives while at least one topic subscriber is attached:
 * the first `subscribeTopic` opens it, the last unsubscribe closes it.
 * Reconnect/backoff/dead-TCP detection all come from `createSSE`; on every
 * (re)connect the server replays a snapshot of each topic. The last frame per
 * topic is cached here so a subscriber attaching mid-stream (a remounting
 * component) is seeded immediately instead of waiting for the next push.
 */

/** topic -> Set<{ onData, onStreamDown }> */
const topicHandlers = new Map();
/** topic -> last payload seen — replayed to late subscribers */
const lastFrames = new Map();
let closeFn = null;

function dispatch(frame) {
  if (!frame || typeof frame.topic !== 'string' || !('data' in frame)) return;
  lastFrames.set(frame.topic, frame.data);
  const handlers = topicHandlers.get(frame.topic);
  if (!handlers) return;
  for (const handler of handlers) handler.onData(frame.data);
}

function streamDown() {
  for (const handlers of topicHandlers.values()) {
    for (const handler of handlers) handler.onStreamDown?.();
  }
}

function hasSubscribers() {
  for (const handlers of topicHandlers.values()) {
    if (handlers.size > 0) return true;
  }
  return false;
}

/**
 * Attach a handler to one topic on the shared events stream.
 *
 * @param {string} topic — `stats` | `vms` | `containers` | `sections` | `discovery`
 * @param {(data: any) => void} onData — called per frame; error frames arrive here
 *   too, carrying the topic's usual `{ error, detail, code? }` shape.
 * @param {() => void} [onStreamDown] — called when the shared connection drops
 *   (before createSSE's backoff reconnect).
 * @returns {() => void} unsubscribe
 */
export function subscribeTopic(topic, onData, onStreamDown) {
  const handler = { onData, onStreamDown };
  let handlers = topicHandlers.get(topic);
  if (!handlers) {
    handlers = new Set();
    topicHandlers.set(topic, handlers);
  }
  handlers.add(handler);

  if (lastFrames.has(topic)) onData(lastFrames.get(topic));
  if (!closeFn) closeFn = createSSE('/api/events', dispatch, streamDown);

  return function unsubscribe() {
    handlers.delete(handler);
    if (closeFn && !hasSubscribers()) {
      closeFn();
      closeFn = null;
      lastFrames.clear(); // next connect (e.g. after re-login) starts from server snapshots
    }
  };
}
