/**
 * The host module's logger, handed in at boot through the facade's
 * `configure({ logger })`, as the managers get theirs; null until then.
 */
let logger = null;

export function setHostLogger(next) {
  logger = next;
}

/** The host module's logger (for its emitters), null until configured. */
export function hostLogger() {
  return logger;
}

/** Log a failure the host code caught and carried on from, with what it was doing. */
export function logHostFailure(err, what, fields = {}) {
  logger?.warn({ ...fields, err: err?.message || String(err), code: err?.code }, `[host] ${what}`);
}

const loggedOnce = new Set();

/**
 * Log a failure of a read that repeats every few seconds (the host stats'
 * sensors and counters) the first time it happens for `key` (the path), so a
 * sensor that always fails is in the journal once, not every tick.
 */
export function logHostFailureOnce(key, err, what, fields = {}) {
  if (loggedOnce.has(key)) return;
  loggedOnce.add(key);
  logHostFailure(err, `${what} (logged once for this path)`, fields);
}

/** True for a filesystem error that means "not there": the optional file is absent. */
export function isAbsent(err) {
  return err?.code === 'ENOENT';
}
