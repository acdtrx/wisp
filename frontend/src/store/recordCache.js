import { assertChangeKind, assertTopic, subscribeChanges, subscribeTopic } from '../api/events.js';
import { CHANGE_KIND } from '../../../shared/wireNames.js';
import { isErrorFrame } from './streamStore.js';

/**
 * @typedef {Object} RecordCue - when a shown record is read again
 * @property {string} [change] - a `CHANGE_KIND`: on a `changes` frame of that kind
 * @property {boolean} [byId] - with `change`: only a frame whose `id` is the record's
 * @property {string} [topic] - a `TOPIC`: on its frames, after the first
 * @property {(frame: any, id: any) => unknown} [key] - with `topic`: only when this
 *   value of the frame changes (error frames skipped)
 *
 * @typedef {Object} RecordKind
 * @property {(id: any, options: { signal: AbortSignal }) => Promise<unknown>} fetch
 * @property {boolean} [singleton] - one record of the kind: it takes no id
 * @property {RecordCue[]} cues
 *
 * @typedef {'idle' | 'loading' | 'ready' | 'error' | 'gone'} RecordStatus
 * @typedef {{ data: any, status: RecordStatus, error: import('../api/errors.js').ApiError | null, reads: number }} RecordSnapshot
 *   `reads` counts the answers applied, an equal one included: a form knows from it
 *   that a read landed after its save (hooks/formState.js)
 */

const IDLE = Object.freeze({ data: null, status: 'idle', error: null, reads: 0 });
const LOADING = Object.freeze({ data: null, status: 'loading', error: null, reads: 0 });

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The records the views show, read from the server (docs/FRONTEND-RULES.md, Data):
 * a record is read while something shows it, once for everyone showing it, again on
 * its cues and when the events stream reconnects, and the read is aborted when
 * nothing shows it any more.
 *
 * The one guard against a stale answer (docs/specs/ERROR-HANDLING.md, Stale
 * responses): every read is numbered. An answer is applied only when it is newer than
 * the last one applied, so a view never shows an older answer after a newer one. A
 * failure counts only when it is the newest read sent: a failed read that a newer
 * read has replaced shows nothing. A failure keeps the data already shown, and
 * stays until a read sent after it succeeds or the user dismisses it. A 404 is
 * "gone", not an error.
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

  function publish(entry) {
    let status;
    if (entry.gone) status = 'gone';
    else if (entry.error) status = 'error';
    else if (entry.hasData) status = 'ready';
    else status = 'loading';
    entry.snapshot = { data: entry.hasData ? entry.data : null, status, error: entry.error, reads: entry.reads };
    for (const listener of entry.listeners) listener();
  }

  function read(entry) {
    if (entry.stopped) return Promise.resolve();
    const n = ++entry.sent;
    const controller = new AbortController();
    entry.inflight.add(controller);
    return entry.spec.fetch(entry.id, { signal: controller.signal })
      .then((data) => {
        if (entry.stopped || n <= entry.applied) return;
        entry.applied = n;
        entry.reads += 1;
        entry.gone = false;
        if (!entry.hasData || !sameValue(entry.data, data)) entry.data = data;
        entry.hasData = true;
        if (n > entry.failedAt) entry.error = null;
        publish(entry);
      }, (err) => {
        if (entry.stopped || controller.signal.aborted || n !== entry.sent) return;
        if (err?.status === 404) {
          entry.applied = n;
          entry.gone = true;
          entry.hasData = false;
          entry.data = null;
          entry.error = null;
        } else {
          entry.failedAt = n;
          entry.error = err;
        }
        publish(entry);
      })
      .finally(() => entry.inflight.delete(controller));
  }

  function start(entry) {
    read(entry);
    const { cues } = entry.spec;
    const changeKinds = cues.filter((c) => c.change).map((c) => c.change);
    /* Every record follows the connect frame `{ kind: 'all' }`: anything may have
     * changed while the stream was down. Each handler returns its read, so a command
     * waiting on the frame waits for it too. */
    entry.offs.push(subscribeChanges(changeKinds, (change) => {
      if (change.kind === CHANGE_KIND.ALL) return read(entry);
      const cue = cues.find((c) => c.change === change.kind);
      if (cue?.byId && change.id !== entry.id) return undefined;
      return read(entry);
    }));
    for (const cue of cues.filter((c) => c.topic)) {
      let seen = false;
      let lastKey;
      entry.offs.push(subscribeTopic(cue.topic, (frame) => {
        if (cue.key) {
          if (isErrorFrame(frame)) return undefined;
          const key = cue.key(frame, entry.id);
          const changed = seen && !sameValue(key, lastKey);
          seen = true;
          lastKey = key;
          return changed ? read(entry) : undefined;
        }
        /* The first frame is the topic's state as the record is read: no news. */
        if (!seen) {
          seen = true;
          return undefined;
        }
        return read(entry);
      }));
    }
  }

  function stop(entry) {
    entry.stopped = true;
    for (const off of entry.offs) off();
    for (const controller of entry.inflight) controller.abort();
    entries.delete(entry.key);
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
          key, spec, id: spec.singleton ? null : id, listeners: new Set(), offs: [], inflight: new Set(),
          sent: 0, applied: 0, failedAt: 0, reads: 0, hasData: false, data: null, error: null, gone: false,
          stopped: false, snapshot: LOADING,
        };
        entries.set(key, entry);
        entry.listeners.add(listener);
        start(entry);
      } else {
        entry.listeners.add(listener);
      }
      return () => {
        entry.listeners.delete(listener);
        if (entry.listeners.size === 0 && !entry.stopped) stop(entry);
      };
    },

    /** @returns {RecordSnapshot} */
    get(kind, id) {
      const spec = kindOf(kind);
      return entries.get(keyOf(kind, spec.singleton ? null : id))?.snapshot ?? LOADING;
    },

    /** Read the record again (a Retry); resolves when the read settles. */
    reload(kind, id) {
      const spec = kindOf(kind);
      const entry = entries.get(keyOf(kind, spec.singleton ? null : id));
      return entry ? read(entry) : Promise.resolve();
    },

    /** Dismiss the record's error while its data is shown. */
    dismiss(kind, id) {
      const spec = kindOf(kind);
      const entry = entries.get(keyOf(kind, spec.singleton ? null : id));
      if (!entry || !entry.error || !entry.hasData) return;
      entry.error = null;
      publish(entry);
    },
  };
}
