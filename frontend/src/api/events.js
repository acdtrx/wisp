import { createSSE } from './sse.js';

/**
 * Topic subscriptions over the single always-on `/api/events` SSE stream.
 *
 * The server multiplexes every continuously-needed feed (host stats, VM list,
 * container list, sections, discovered peers, change references) as
 * `{ topic, data }` frames on one connection, because browsers cap
 * plain-HTTP/1.1 connections at 6 per origin and each SSE stream holds one for
 * its lifetime — five dedicated streams plus a per-entity stats stream used to
 * exhaust the pool and queue every further fetch indefinitely.
 *
 * One shared connection lives while at least one topic subscriber is attached:
 * the first `subscribeTopic` opens it, the last unsubscribe closes it.
 * Reconnect/backoff/dead-TCP detection all come from `createSSE`; on every
 * (re)connect the server replays a snapshot of each topic. The last frame per
 * topic (except `changes`) is cached here so a subscriber attaching mid-stream
 * (a remounting component) is seeded immediately instead of waiting for the
 * next push.
 */

/** topic -> Set<{ onData, onStreamDown }> */
const topicHandlers = new Map();
/** topic -> last payload seen — replayed to late subscribers */
const lastFrames = new Map();
/** `changes` frames are cues to GET, not state: a late subscriber GETs on mount
 *  instead, so replaying the last cue would only repeat that GET. */
const CHANGES_TOPIC = 'changes';
/** topic -> Set<release>, released by the topic's next frame */
const frameWaiters = new Map();
let closeFn = null;

function releaseFrameWaiters(topic) {
  const waiters = frameWaiters.get(topic);
  if (!waiters) return;
  for (const release of waiters) release();
  waiters.clear();
}

function dispatch(frame) {
  if (!frame || typeof frame.topic !== 'string' || !('data' in frame)) return;
  if (frame.topic !== CHANGES_TOPIC) lastFrames.set(frame.topic, frame.data);
  const handlers = topicHandlers.get(frame.topic);
  if (handlers) {
    for (const handler of handlers) handler.onData(frame.data);
  }
  releaseFrameWaiters(frame.topic);
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
 * @param {string} topic — `stats` | `vms` | `containers` | `sections` | `home` |
 *   `discovery` | `backups` | `changes` (prefer `subscribeChanges` for the last)
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
      for (const topic of frameWaiters.keys()) releaseFrameWaiters(topic);
    }
  };
}

/**
 * Follow the `changes` topic: references to records saved on the server
 * (`{ kind, id? }`). `onChange` runs for every frame whose kind is in `kinds`, and
 * for the `{ kind: 'all' }` each (re)connect opens with — anything may have changed
 * while the stream was down. The caller GETs what it shows, on mount as well: no
 * frame is replayed to a late subscriber.
 *
 * @param {string[]} kinds — e.g. `['settings']`
 * @param {(change: { kind: string, id?: string }) => void} onChange
 * @returns {() => void} unsubscribe
 */
export function subscribeChanges(kinds, onChange) {
  const wanted = new Set(kinds);
  return subscribeTopic(CHANGES_TOPIC, (change) => {
    if (!change || typeof change.kind !== 'string') return;
    if (change.kind === 'all' || wanted.has(change.kind)) onChange(change);
  });
}

/**
 * Send a command whose new state arrives on `topic`, and resolve with its ack once
 * the topic's next frame has arrived too: the control that sent it stays busy until
 * the client holds the new state, so a quick second click can't act on the old one.
 * The wait starts before the request, since the frame can beat the ack; any frame
 * of the topic ends it, a reconnect snapshot included, so it can't hang while the
 * stream is up. An error from the command ends it at once. With no stream open
 * there is no frame to wait for.
 *
 * @template T
 * @param {string} topic
 * @param {() => Promise<T>} send
 * @returns {Promise<T>}
 */
export async function sendAndAwaitTopic(topic, send) {
  if (!closeFn) return send();
  let release;
  const frame = new Promise((resolve) => { release = resolve; });
  let waiters = frameWaiters.get(topic);
  if (!waiters) {
    waiters = new Set();
    frameWaiters.set(topic, waiters);
  }
  waiters.add(release);
  let ack;
  try {
    ack = await send();
  } catch (err) {
    waiters.delete(release);
    throw err;
  }
  await frame;
  return ack;
}
