/**
 * Pure container manager helpers (no containerd), shared by the linux and
 * darwin implementations: the manager's error factory and its wrapping twin.
 */

/** Set by every Wisp error factory (lib/appErrors.js, which this manager cannot import). */
const WISP_ERROR = Symbol.for('wisp.error');

export function containerError(code, message, raw) {
  const err = new Error(message);
  err.code = code;
  if (raw) err.raw = raw;
  Object.defineProperty(err, WISP_ERROR, { value: true });
  return err;
}

/** True for an error a Wisp factory built: its code is from the table, its message Wisp's words. */
export function isWispError(err) {
  return err?.[WISP_ERROR] === true;
}

/**
 * The error that says `message` about the failures `inners` — the manager's
 * twin of lib/appErrors.js's wrapAppError (docs/specs/ERROR-HANDLING.md → The
 * error body): a Wisp error's message joins the outer message whole and its
 * raw cause is the raw cause; any other error's text is all cause.
 */
export function wrapContainerError(code, message, ...inners) {
  const messages = [];
  const raws = [];
  for (const inner of inners) {
    if (isWispError(inner)) {
      messages.push(inner.message);
      if (inner.raw) raws.push(inner.raw);
    } else {
      raws.push(inner?.message || String(inner));
    }
  }
  return containerError(code, messages.length ? `${message}: ${messages.join('; ')}` : message, raws.join('; '));
}
