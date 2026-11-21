/**
 * The value logic of the command hook (useCommand.js), pure so it can be tested. A
 * hook's commands are named by key (a table's rows, or a control's own command): runs
 * of different keys are independent and may be in flight together; a key runs once
 * at a time; each key holds its own error, until it is dismissed or that key runs
 * again — another key's run never touches it. A run may say what its key stands for
 * (`about`: what its error names, the row it runs on), held with the key while it runs
 * and while its error stands, so a key is never parsed back.
 *
 * @typedef {{ inflight: ReadonlySet<unknown>, errors: ReadonlyMap<unknown, unknown>, abouts: ReadonlyMap<unknown, unknown> }} CommandState
 */

/** The key of a hook's single command, when its caller names none. */
export const ONLY = 'command';

/** @returns {CommandState} */
export const initialCommandState = () => ({ inflight: new Set(), errors: new Map(), abouts: new Map() });

const withAbout = (abouts, key, about) => {
  const next = new Map(abouts);
  if (about === undefined) next.delete(key);
  else next.set(key, about);
  return next;
};

export const isRunning = (state, key) => state.inflight.has(key);

/** A run of `key` begins, with what it is `about`: its last error goes. Unchanged when
 *  `key` is already in flight. */
export function begin(state, key, about) {
  if (state.inflight.has(key)) return state;
  const inflight = new Set(state.inflight).add(key);
  const abouts = withAbout(state.abouts, key, about);
  if (!state.errors.has(key)) return { ...state, inflight, abouts };
  const errors = new Map(state.errors);
  errors.delete(key);
  return { inflight, errors, abouts };
}

/** The run of `key` ended: with its error, or none. */
export function end(state, key, error = null) {
  const inflight = new Set(state.inflight);
  inflight.delete(key);
  if (error == null) return { ...state, inflight, abouts: withAbout(state.abouts, key, undefined) };
  return { ...state, inflight, errors: new Map(state.errors).set(key, error) };
}

/** A failure found before sending (a validation), held like the command's own. */
export const fail = (state, key, error, about) => ({
  ...state, errors: new Map(state.errors).set(key, error), abouts: withAbout(state.abouts, key, about),
});

export function dismiss(state, key) {
  if (!state.errors.has(key)) return state;
  const errors = new Map(state.errors);
  errors.delete(key);
  return { ...state, errors, abouts: state.inflight.has(key) ? state.abouts : withAbout(state.abouts, key, undefined) };
}
