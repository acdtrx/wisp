import { useEffect, useRef } from 'react';
import { subscribeChanges } from '../api/events.js';

/**
 * Re-read what a view shows when the `changes` topic names its record (`kind`,
 * `id`), or on the `{ kind: 'all' }` each (re)connect opens with. The view still
 * GETs on mount itself: no frame is replayed to a late subscriber. `refetch`
 * returns its promise, so a command waiting on the frame (sendAndAwaitChange)
 * waits for this re-read too.
 *
 * @param {string} kind
 * @param {string | null | undefined} id — nothing is followed while it is empty
 * @param {() => Promise<unknown>} refetch
 */
export function useChanges(kind, id, refetch) {
  const refetchRef = useRef(refetch);
  useEffect(() => {
    refetchRef.current = refetch;
  });

  useEffect(() => {
    if (!id) return undefined;
    return subscribeChanges([kind], (change) => {
      if (change.kind === 'all' || change.id === id) return refetchRef.current();
      return undefined;
    });
  }, [kind, id]);
}

/**
 * `useChanges` for a kind that names one record or a whole list (no `id`):
 * re-read on every frame of that kind and on `{ kind: 'all' }`.
 *
 * @param {string} kind
 * @param {() => Promise<unknown>} refetch
 */
export function useKindChanges(kind, refetch) {
  const refetchRef = useRef(refetch);
  useEffect(() => {
    refetchRef.current = refetch;
  });

  useEffect(() => subscribeChanges([kind], () => refetchRef.current()), [kind]);
}
