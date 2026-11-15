import { useCallback, useRef, useState } from 'react';

/**
 * One command at a time for a control: `run(command)` ignores a call while the
 * previous command is in flight, and `busy` disables the control meanwhile. The
 * guard is a ref, so a second click that lands before the re-render is refused
 * too. `run` rejects with the command's error.
 *
 * @returns {[boolean, (command: () => Promise<unknown>) => Promise<unknown>]}
 */
export function useBusyCommand() {
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (command) => {
    if (busyRef.current) return undefined;
    busyRef.current = true;
    setBusy(true);
    try {
      return await command();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);
  return [busy, run];
}
