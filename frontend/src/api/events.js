import { openStream } from './sse.js';
import { CHANGE_KIND, TOPIC } from '../../../shared/wireNames.js';

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
 * Reconnect/backoff/dead-TCP detection all come from `openStream`; on every
 * (re)connect the server replays a snapshot of each topic. The last frame per
 * topic (except `changes`) is cached here so a subscriber attaching mid-stream
 * (a remounting component) is seeded immediately instead of waiting for the
 * next push.
 */

const TOPICS = new Set(Object.values(TOPIC));
const CHANGE_KINDS = new Set(Object.values(CHANGE_KIND));

/** A name the code passes in (a variable no lint sees) is checked against the wire's
 *  names, so a typo fails the first time it runs instead of waiting for frames that
 *  never come. */
export function assertTopic(topic) {
  if (!TOPICS.has(topic)) throw new Error(`Unknown events topic: ${topic}`);
}

export function assertChangeKind(kind) {
  if (!CHANGE_KINDS.has(kind) || kind === CHANGE_KIND.ALL) throw new Error(`Unknown change kind: ${kind}`);
}

/** topic -> Set<{ onData, onStreamDown }> */
const topicHandlers = new Map();
/** topic -> last payload seen — replayed to late subscribers */
const lastFrames = new Map();
let closeFn = null;
/** The ApiError Wisp refused the shared stream with, which ended it; kept until the
 *  last subscriber leaves, so a late subscriber is told too. */
let refusal = null;

function dispatch(frame) {
  if (!frame || typeof frame.topic !== 'string' || !('data' in frame)) return;
  /* `changes` frames are cues to GET, not state: a late subscriber GETs on mount
   * instead, so replaying the last cue would only repeat that GET. */
  if (frame.topic !== TOPIC.CHANGES) lastFrames.set(frame.topic, frame.data);
  const handlers = topicHandlers.get(frame.topic);
  if (handlers) for (const handler of handlers) handler.onData(frame.data);
}

/** The connection dropped (no `err`: openStream reconnects), or Wisp refused the
 *  stream (`err`: it has ended, and no frame will come). */
function streamDown(err) {
  if (err) refusal = err;
  for (const handlers of topicHandlers.values()) {
    for (const handler of handlers) handler.onStreamDown?.(err);
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
 * @param {string} topic — a `TOPIC` (prefer `subscribeChanges` for `TOPIC.CHANGES`)
 * @param {(data: any) => void} onData — called per frame; error frames arrive here
 *   too, carrying the topic's usual `{ error, detail, code? }` shape.
 * @param {(refusal?: import('./errors.js').ApiError) => void} [onStreamDown] — called
 *   with nothing when the shared connection drops (before openStream's backoff
 *   reconnect); with the ApiError when Wisp refused the stream, which ended it (on
 *   subscribing too, while that refusal stands).
 * @returns {() => void} unsubscribe
 */
export function subscribeTopic(topic, onData, onStreamDown) {
  assertTopic(topic);
  const handler = { onData, onStreamDown };
  let handlers = topicHandlers.get(topic);
  if (!handlers) {
    handlers = new Set();
    topicHandlers.set(topic, handlers);
  }
  handlers.add(handler);

  if (lastFrames.has(topic)) onData(lastFrames.get(topic));
  if (refusal) onStreamDown?.(refusal);
  if (!closeFn) closeFn = openStream('/api/events', dispatch, { onDown: streamDown });

  return function unsubscribe() {
    handlers.delete(handler);
    if (closeFn && !hasSubscribers()) {
      closeFn();
      closeFn = null;
      lastFrames.clear(); // next connect (e.g. after re-login) starts from server snapshots
      refusal = null; // and asks again
    }
  };
}

/**
 * Ask the server again: close the shared stream and open it anew, a stream Wisp
 * refused included (the refusal is forgotten). Each topic's connect frame then
 * brings its current state, gathered again. Nothing happens while no one follows
 * the stream.
 */
export function reconnectEvents() {
  if (!closeFn) return;
  closeFn();
  refusal = null;
  closeFn = openStream('/api/events', dispatch, { onDown: streamDown });
}

/**
 * Follow the `changes` topic: references to records saved on the server
 * (`{ kind, id? }`). `onChange` runs for every frame whose kind is in `kinds`, and
 * for the `{ kind: 'all' }` each (re)connect opens with — anything may have changed
 * while the stream was down. The caller GETs what it shows, on mount as well: no
 * frame is replayed to a late subscriber.
 *
 * @param {string[]} kinds — `CHANGE_KIND`s, e.g. `[CHANGE_KIND.SETTINGS]`
 * @param {(change: { kind: string, id?: string }) => void} onChange
 * @returns {() => void} unsubscribe
 */
export function subscribeChanges(kinds, onChange) {
  kinds.forEach(assertChangeKind);
  const wanted = new Set(kinds);
  return subscribeTopic(TOPIC.CHANGES, (change) => {
    if (!change || typeof change.kind !== 'string') return;
    if (change.kind === CHANGE_KIND.ALL || wanted.has(change.kind)) onChange(change);
  });
}
