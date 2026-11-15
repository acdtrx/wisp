import { useEffect, useRef } from 'react';
import { subscribeChanges } from '../api/events.js';

/**
 * Re-read what a view shows when the `changes` topic names its record (`kind`,
 * `id`), or on the `{ kind: 'all' }` each (re)connect opens with. The view still
 * GETs on mount itself: no frame is replayed to a late subscriber.
 *
 * @param {string} kind
 * @param {string | null | undefined} id — nothing is followed while it is empty
 * @param {() => unknown} refetch
 */
export function useChanges(kind, id, refetch) {
  const refetchRef = useRef(refetch);
  useEffect(() => {
    refetchRef.current = refetch;
  });

  useEffect(() => {
    if (!id) return undefined;
    return subscribeChanges([kind], (change) => {
      if (change.kind === 'all' || change.id === id) refetchRef.current();
    });
  }, [kind, id]);
}
