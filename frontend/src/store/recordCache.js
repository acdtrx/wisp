import { assertChangeKind, assertTopic, subscribeChanges, subscribeTopic } from '../api/events.js';
import { CHANGE_KIND } from '../../../shared/wireNames.js';
import { isErrorFrame } from './streamStore.js';

/**
 * @typedef {Object} RecordCue - when a shown record is read again
 * @property {string} [change] - a `CHANGE_KIND`: on a `changes` frame of that kind
 * @property {boolean} [byId] - with `change`: only a frame whose `id` is the record's
 * @property {(id: any) => any} [idOf] - with `byId`: the frame's id for a record id (a
 *   record of a part of the frame's subject: a mount's file is its container's)
 * @property {string} [topic] - a `TOPIC`: on its frames, after the first
 * @property {(frame: any, id: any) => unknown} [key] - with `topic`: only when this
 *   value of the frame changes (error frames skipped)
 *
 * @typedef {Object} RecordKind
 * @property {(id: any, options: { signal: AbortSignal }) => Promise<unknown>} fetch
 * @property {boolean} [singleton] - one record of the kind: it takes no id, and its
 *   last data is kept for the session (a returning view shows it while it is read again)
 * @property {RecordCue[]} cues
 * @property {string[]} [goneCodes] - the error codes that mean the record does not exist
 *   (its subject's own not-found): such an answer is "gone"; any other is an error
 *
 * @typedef {'idle' | 'loading' | 'ready' | 'error' | 'gone'} RecordStatus
 * @typedef {{ data: any, status: RecordStatus, error: import('../api/errors.js').ApiError | null, reading: boolean }} RecordSnapshot
 *   `reading`: a read is on its way (a Retry shows it busy)
 */

const IDLE = Object.freeze({ data: null, status: 'idle', error: null, reading: false });
const LOADING = Object.freeze({ data: null, status: 'loading', error: null, reading: true });

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The records the views show, read from the server (docs/FRONTEND-RULES.md, Data):
 * a record is read while something shows it, once for everyone showing it, again on
 * its cues and when the events stream (re)connects — a page load therefore reads each
 * record twice, its first read and the connect frame's — and the read is aborted when
 * nothing shows it any more. A keyed record is then dropped; a singleton keeps its last
 * data for the session, until `clear()` (sign-out).
 *
 * The one guard against a stale answer (docs/specs/ERROR-HANDLING.md, Stale
 * responses): every read is numbered. An answer is applied only when it is newer than
 * the last one applied, so a view never shows an older answer after a newer one. A
 * failure counts only when it is the newest read sent: a failed read that a newer
 * read has replaced shows nothing. A failure keeps the data already shown, and
 * stays until a read sent after it succeeds or the user dismisses it.
 *
 * @param {Record<string, RecordKind>} kinds
 */
export function createRecordCache(kinds) {
  for (const [name, kind] of Object.entries(kinds)) {
    if (typeof kind.fetch !== 'function') throw new Error(`Record kind ${name} has no fetch`);
    for (const cue of kind.cues) {
      if (cue.change) assertChangeKind(cue.change);
      if (cue.topic) assertTopic(cue.topic);
      if (!cue.change && !cue.topic) throw new Error(`Record kind ${name} has a cue with neither change nor topic`);
    }
  }

  /** key → entry */
  const entries = new Map();

  const keyOf = (kind, id) => `${kind}\u0000${JSON.stringify(id ?? null)}`;

  function kindOf(kind) {
    const spec = kinds[kind];
    if (!spec) throw new Error(`Unknown record kind: ${kind}`);
    return spec;
  }

  function entryOf(kind, id) {
    const spec = kindOf(kind);
    return entries.get(keyOf(kind, spec.singleton ? null : id));
  }

  function publish(entry) {
    let status;
    if (entry.gone) status = 'gone';
    else if (entry.error) status = 'error';
    else if (entry.hasData) status = 'ready';
    else status = 'loading';
    entry.snapshot = {
      data: entry.hasData ? entry.data : null, status, error: entry.error, reading: entry.inflight.size > 0,
    };
    for (const listener of entry.listeners) listener();
  }

  /** Read the entry once; resolves `true` when the read answered (applied or not, or the
   *  record is gone), `false` when it failed or was aborted. */
  function read(entry) {
    if (!entry.live) return Promise.resolve(false);
    const n = ++entry.sent;
    const controller = new AbortController();
    const settled = () => {
      entry.inflight.delete(controller);
      if (entry.live) publish(entry);
    };
    entry.inflight.set(controller, null);
    publish(entry);
    const promise = entry.spec.fetch(entry.id, { signal: controller.signal })
      .then((data) => {
        if (!entry.live || n <= entry.applied) return true;
        entry.applied = n;
        entry.gone = false;
        if (!entry.hasData || !sameValue(entry.data, data)) entry.data = data;
        entry.hasData = true;
        if (n > entry.failedAt) entry.error = null;
        return true;
      }, (err) => {
        if (!entry.live || controller.signal.aborted) return false;
        /* Replaced by a newer read: that read's outcome is this one's, settled or not. */
        if (n !== entry.sent) return entry.newest;
        if (entry.spec.goneCodes?.includes(err?.code)) {
          entry.applied = n;
          entry.gone = true;
          entry.hasData = false;
          entry.data = null;
          entry.error = null;
          return true;
        }
        entry.failedAt = n;
        entry.error = err;
        return false;
      })
      .finally(settled);
    entry.inflight.set(controller, promise);
    entry.newest = promise;
    return promise;
  }

  function start(entry) {
    entry.live = true;
    read(entry);
    const { cues } = entry.spec;
    const changeKinds = cues.filter((c) => c.change).map((c) => c.change);
    /* Every record follows the connect frame `{ kind: 'all' }`: anything may have
     * changed while the stream was down. */
    entry.offs.push(subscribeChanges(changeKinds, (change) => {
      if (change.kind === CHANGE_KIND.ALL) {
        read(entry);
        return;
      }
      const cue = cues.find((c) => c.change === change.kind);
      if (cue?.byId && change.id !== (cue.idOf ? cue.idOf(entry.id) : entry.id)) return;
      read(entry);
    }));
    for (const cue of cues.filter((c) => c.topic)) {
      let seen = false;
      let lastKey;
      entry.offs.push(subscribeTopic(cue.topic, (frame) => {
        if (cue.key) {
          if (isErrorFrame(frame)) return;
          const key = cue.key(frame, entry.id);
          const changed = seen && !sameValue(key, lastKey);
          seen = true;
          lastKey = key;
          if (changed) read(entry);
          return;
        }
        /* The first frame is the topic's state as the record is read: no news. */
        if (!seen) {
          seen = true;
          return;
        }
        read(entry);
      }));
    }
  }

  function stop(entry) {
    entry.live = false;
    for (const off of entry.offs) off();
    entry.offs = [];
    for (const controller of entry.inflight.keys()) controller.abort();
    entry.inflight.clear();
    if (!entry.spec.singleton) {
      entries.delete(entry.key);
      return;
    }
    // Kept for the session: what a returning view shows while it reads again.
    entry.gone = false;
    entry.error = null;
    entry.snapshot = { ...entry.snapshot, status: entry.hasData ? 'ready' : 'loading', error: null, reading: false };
  }

  return {
    /** The idle snapshot, for a view that names no record yet. */
    IDLE,

    /** Whether records of `kind` are named by an id. */
    takesId: (kind) => !kindOf(kind).singleton,

    /** Follow record `kind` / `id`: the first follower reads it, the last one's leaving aborts it. */
    subscribe(kind, id, listener) {
      const spec = kindOf(kind);
      const key = keyOf(kind, spec.singleton ? null : id);
      let entry = entries.get(key);
      if (!entry) {
        entry = {
          key, spec, id: spec.singleton ? null : id, listeners: new Set(), offs: [], inflight: new Map(),
          sent: 0, applied: 0, failedAt: 0, hasData: false, data: null, error: null, gone: false,
          live: false, snapshot: LOADING,
        };
        entries.set(key, entry);
      }
      entry.listeners.add(listener);
      if (!entry.live) start(entry);
      return () => {
        entry.listeners.delete(listener);
        if (entry.listeners.size === 0 && entry.live) stop(entry);
      };
    },

    /** @returns {RecordSnapshot} */
    get(kind, id) {
      return entryOf(kind, id)?.snapshot ?? LOADING;
    },

    /** A Retry: read the record again, or join the read already on its way. */
    reload(kind, id) {
      const entry = entryOf(kind, id);
      if (!entry?.live) return Promise.resolve();
      const pending = [...entry.inflight.values()].at(-1);
      return pending ?? read(entry);
    },

    /** Dismiss the record's error while its data is shown. */
    dismiss(kind, id) {
      const entry = entryOf(kind, id);
      if (!entry || !entry.error || !entry.hasData) return;
      entry.error = null;
      publish(entry);
    },

    /** Forget every record (sign-out). */
    clear() {
      for (const entry of entries.values()) {
        entry.live = false;
        for (const off of entry.offs) off();
        for (const controller of entry.inflight.keys()) controller.abort();
      }
      entries.clear();
    },
  };
}
