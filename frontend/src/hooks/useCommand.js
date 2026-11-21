import { useCallback, useMemo, useRef, useState } from 'react';

import { runCommand } from '../store/commands.js';
import * as cs from './commandState.js';

/**
 * Commands a view runs (store/commands.js), named by key (commandState.js): a key
 * runs once at a time and holds its own error until it is dismissed or runs again;
 * different keys run in parallel (docs/FRONTEND-RULES.md, Data and Errors). A view
 * disables the control of a key in flight (`isBusy(key)`), so a click is never
 * ignored; the in-flight guard is a ref, so a second click that lands before the
 * re-render cannot start a second run either. A view with one command names no key.
 * A command is busy until the server answers: its ack, or for one that runs as a job
 * (`job`), the job's end.
 *
 * `run(fn, options)` resolves `true` when the command succeeded, `false` when it
 * failed (its error is then held) or its key was already in flight. `fn`'s answer, a
 * job's result included, reaches `options.onDone`.
 *
 * @returns {{
 *   run: (fn: () => Promise<unknown>, options?: { key?: unknown, about?: unknown, job?: boolean,
 *     onAck?: (ack: any) => void, onDone?: (result: unknown) => void }) => Promise<boolean>,
 *   busy: boolean, isBusy: (key?: unknown) => boolean, running: unknown[], aboutOf: (key: unknown) => unknown,
 *   error: unknown, errorOf: (key: unknown) => unknown, errors: Array<{ key: unknown, error: unknown, about: unknown }>,
 *   dismiss: (key?: unknown) => void, fail: (error: unknown, key?: unknown) => void }}
 *   `busy`: any key in flight, `running` which; `error` / `dismiss()`: the keyless command's;
 *   `about`: what a run said its key stands for, while it runs and while its error stands.
 */
export function useCommand() {
  const inflightRef = useRef(new Set());
  const [state, setState] = useState(cs.initialCommandState);

  const run = useCallback(async (fn, { key = cs.ONLY, about, onDone, ...options } = {}) => {
    if (inflightRef.current.has(key)) return false;
    inflightRef.current.add(key);
    setState((s) => cs.begin(s, key, about));
    try {
      const result = await runCommand(fn, options);
      inflightRef.current.delete(key);
      setState((s) => cs.end(s, key));
      onDone?.(result);
      return true;
    } catch (err) {
      inflightRef.current.delete(key);
      setState((s) => cs.end(s, key, err));
      return false;
    }
  }, []);

  const dismiss = useCallback((key = cs.ONLY) => setState((s) => cs.dismiss(s, key)), []);
  const fail = useCallback((err, key = cs.ONLY, about) => setState((s) => cs.fail(s, key, err, about)), []);

  return useMemo(() => ({
    run,
    dismiss,
    fail,
    busy: state.inflight.size > 0,
    isBusy: (key = cs.ONLY) => state.inflight.has(key),
    running: [...state.inflight],
    aboutOf: (key) => state.abouts.get(key),
    error: state.errors.get(cs.ONLY) ?? null,
    errorOf: (key) => state.errors.get(key) ?? null,
    errors: [...state.errors].map(([key, error]) => ({ key, error, about: state.abouts.get(key) })),
  }), [run, dismiss, fail, state]);
}
