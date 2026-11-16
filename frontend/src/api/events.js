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
/** Commands waiting for a frame: { topic, matches(data), release } */
const frameWaiters = new Set();
let closeFn = null;

/** Release the waiters a frame satisfies (every waiter when `frame` is null), with
 *  the re-reads the frame's handlers started. */
function releaseFrameWaiters(frame, rereads = []) {
  for (const waiter of frameWaiters) {
    if (frame && (waiter.topic !== frame.topic || !waiter.matches(frame.data))) continue;
    frameWaiters.delete(waiter);
    waiter.release(rereads);
  }
}

function dispatch(frame) {
  if (!frame || typeof frame.topic !== 'string' || !('data' in frame)) return;
  if (frame.topic !== CHANGES_TOPIC) lastFrames.set(frame.topic, frame.data);
  const handlers = topicHandlers.get(frame.topic);
  /* A handler that starts a re-read returns its promise: a command waiting on this
   * frame waits for those to settle too. A re-read shows its own failure in its view
   * (vmStore's error banner for the VM config, USBSection's and CloudInitSection's
   * load errors), so the failure reaches the user once whether or not a command waits;
   * the catch only keeps a stray rejection from going unhandled. */
  const rereads = [];
  if (handlers) {
    for (const handler of handlers) {
      const result = handler.onData(frame.data);
      if (result && typeof result.then === 'function') {
        result.catch(() => {});
        rereads.push(result);
      }
    }
  }
  releaseFrameWaiters(frame, rereads);
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
      releaseFrameWaiters(null); // no stream, no frame to wait for
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
 * @param {(change: { kind: string, id?: string }) => (Promise<unknown> | void)} onChange —
 *   return the promise of a re-read it starts, so a command waiting on the frame
 *   waits for it to settle too (`sendAndAwaitChange`); the re-read shows its own
 *   failure
 * @returns {() => void} unsubscribe
 */
export function subscribeChanges(kinds, onChange) {
  const wanted = new Set(kinds);
  return subscribeTopic(CHANGES_TOPIC, (change) => {
    if (!change || typeof change.kind !== 'string') return;
    if (change.kind === 'all' || wanted.has(change.kind)) return onChange(change);
    return undefined;
  });
}

/** Send, then wait for the first frame of `topic` that `matches`; the wait starts
 *  before the request, since the frame can beat the ack. */
/** How long a command waits for its frame (and the re-reads it starts) after the ack.
 *  The command was accepted, so the wait then ends with no error (FRONTEND-RULES, Data;
 *  CODING-RULES §6: nothing waits forever). */
const FRAME_WAIT_MS = 30_000;

async function sendAndAwaitFrame(topic, matches, send) {
  if (!closeFn) return send();
  let release;
  const frame = new Promise((resolve) => { release = resolve; });
  const waiter = { topic, matches, release };
  frameWaiters.add(waiter);
  let ack;
  try {
    ack = await send();
  } catch (err) {
    frameWaiters.delete(waiter);
    throw err;
  }
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(resolve, FRAME_WAIT_MS, null); });
  try {
    const rereads = await Promise.race([frame, deadline]);
    if (rereads === null) {
      frameWaiters.delete(waiter); // no frame within the deadline: the command still stands
      return ack;
    }
    /* Every re-read the frame started settles before the command resolves (within the
     * same deadline). The ack already succeeded, so the command resolves either way: a
     * failed re-read shows in its own view. A matching frame that arrives before the
     * command's own (a reconnect's snapshot, another cue for the same record) can still
     * resolve it onto the old state: docs/BACKLOG.md, "A command's busy wait can end on
     * a frame it didn't cause". */
    await Promise.race([Promise.allSettled(rereads), deadline]);
    return ack;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send a command whose new state arrives on `topic`, and resolve with its ack once
 * the topic's next frame has arrived too: the control that sent it stays busy until
 * the client holds the new state, so a quick second click can't act on the old one.
 * The first frame of the topic that `matches` ends the wait — by default any frame,
 * a reconnect snapshot included — and so does 30 s without one. An error from the
 * command ends it at once. With no stream open there is no frame to wait for.
 *
 * @template T
 * @param {string} topic
 * @param {() => Promise<T>} send
 * @param {(data: any) => boolean} [matches] — a frame that carries the command's
 *   new state; a narrower test waits until the stream brings that state
 * @returns {Promise<T>}
 */
export function sendAndAwaitTopic(topic, send, matches = () => true) {
  return sendAndAwaitFrame(topic, matches, send);
}

/**
 * Like `sendAndAwaitTopic`, for a command whose new state is announced on the
 * `changes` topic: resolves once a `changes` frame names that record (`kind`,
 * `id`) or the connect snapshot `{ kind: 'all' }` arrives and every re-read its
 * subscribers started (each returns its promise) has settled. A failed re-read
 * doesn't fail the command, whose ack succeeded: it shows in its own view.
 *
 * @template T
 * @param {string} kind
 * @param {string} id
 * @param {() => Promise<T>} send
 * @returns {Promise<T>}
 */
export function sendAndAwaitChange(kind, id, send) {
  return sendAndAwaitFrame(
    CHANGES_TOPIC,
    (change) => change?.kind === 'all' || (change?.kind === kind && change?.id === id),
    send,
  );
}
