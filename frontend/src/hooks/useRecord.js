import { useCallback, useMemo, useSyncExternalStore } from 'react';

import { records } from '../store/records.js';

const noop = () => {};
const unsubscribed = () => noop;

/**
 * A record from the server, read while this view shows it (store/records.js):
 * `{ data, status, error, reading, id, reload, dismiss }`, `status` one of `loading`,
 * `ready`, `error` (the data, if any, is still the last good one), `gone` (the server
 * answered the kind's not-found) or `idle` (no `id`: nothing is read); `reading` while
 * a read is on its way. Every view showing the same record shares one read.
 *
 * @param {string | null} kind — a `RECORD` kind; none while the view shows no record
 * @param {unknown} [id] — the record's id (none for a kind with one record); an array
 *   for a record named by several parts
 */
export function useRecord(kind, id) {
  /* The id by value, so a new array of the same parts follows the same record. */
  const idKey = JSON.stringify(id ?? null);
  const subscribe = useCallback((listener) => {
    const wanted = JSON.parse(idKey);
    return records.subscribe(kind, wanted, listener);
  }, [kind, idKey]);
  /* No kind, or a kind that takes an id with an empty one: nothing is read. */
  const idle = kind == null || (records.takesId(kind) && (id == null || id === ''));
  const snapshot = useSyncExternalStore(
    idle ? unsubscribed : subscribe,
    () => (idle ? records.IDLE : records.get(kind, JSON.parse(idKey))),
  );
  return useMemo(() => ({
    ...snapshot,
    /** The id the record is read by (null when nothing is read). */
    id: idle ? null : JSON.parse(idKey),
    reload: () => records.reload(kind, JSON.parse(idKey)),
    dismiss: () => records.dismiss(kind, JSON.parse(idKey)),
  }), [snapshot, kind, idKey, idle]);
}
