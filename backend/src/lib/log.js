/**
 * The backend's one logger, for Wisp's glue: the start's logger (index.js
 * sets it first thing in main(); the app is handed the same one). Fenced
 * modules get it from their configure({ logger }) instead, never from here;
 * a route logs to request.log, a child of it.
 *
 * Before it is set (a module's import, a unit test) log() is a logger that
 * writes nothing: nothing the backend runs logs before main() has set it.
 */
const SILENT = Object.freeze({
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child() { return SILENT; },
});

let current = null;

/** Set the process logger (index.js, once, before anything else runs). */
export function setLog(logger) {
  current = logger;
}

/** The process logger. */
export function log() {
  return current ?? SILENT;
}
