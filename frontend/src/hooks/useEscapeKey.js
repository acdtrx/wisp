import { useEffect } from 'react';

/**
 * Call callback when Escape is pressed while active is true.
 * Listens on `document` in the **bubble** phase so focused elements (e.g. inputs) receive the
 * event first. Shell deselect (`AppLayout`) skips handling Escape when `[data-wisp-modal-root]` is present.
 * @param {boolean} active - Only listen when true
 * @param {() => void} callback - Called on Escape keydown. Should be memoised (e.g. useCallback) to avoid re-subscribing every render.
 */
export function useEscapeKey(active, callback) {
  useEffect(() => {
    if (!active) return;
    const handler = (e) => {
      if (e.key === 'Escape') callback();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [active, callback]);
}
