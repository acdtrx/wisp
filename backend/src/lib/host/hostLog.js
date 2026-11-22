/**
 * The host module's logger, handed in at boot through the facade's
 * `configure({ logger })`, as the managers get theirs; null until then.
 */
let logger = null;

export function setHostLogger(next) {
  logger = next;
}

/** Log a failure the host code caught and carried on from, with what it was doing. */
export function logHostFailure(err, what, fields = {}) {
  logger?.warn({ ...fields, err: err?.message || String(err), code: err?.code }, `[host] ${what}`);
}

/** True for a filesystem error that means "not there": the optional file is absent. */
export function isAbsent(err) {
  return err?.code === 'ENOENT';
}
