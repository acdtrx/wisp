/**
 * The one change emitter: a set of handlers, a subscribe that returns its
 * unsubscribe, and an emit that calls each handler.
 *
 * - Handlers run synchronously, in subscription order, over a copy of the set
 *   taken when `emit` starts: a handler added during an emit first runs on the
 *   next one, one removed during it still runs this once.
 * - A handler that throws, or whose returned promise rejects, is logged (through
 *   `getLogger()`, naming `label`) and the others still run: `emit` never throws.
 *   An async handler is not awaited.
 * - Subscribing the same function twice keeps it once; unsubscribing is
 *   idempotent.
 *
 * What a change is (a list that differs, a replay to a late subscriber) is the
 * owner's: it decides when to emit and what a new subscriber is told.
 */

/** Report a handler's failure: the owner's logger, or (none set yet) a process warning. */
function reportFailure(getLogger, label, err) {
  const logger = getLogger?.();
  if (logger?.warn) {
    logger.warn({ err: err?.message || String(err) }, `${label} handler failed`);
    return;
  }
  process.emitWarning(err instanceof Error ? err : new Error(String(err)), { code: 'WISP_HANDLER_FAILED', detail: label });
}

/**
 * @param {string} label - names the event in a failure's log line, e.g. `[vmManager] domain-change`
 * @param {() => ({ warn: Function } | null | undefined)} getLogger - the owner's logger, read at each failure
 * @returns {{ subscribe: (handler: Function) => () => void, emit: (...args: unknown[]) => void, size: () => number }}
 */
export function createEmitter(label, getLogger) {
  const handlers = new Set();
  return {
    subscribe(handler) {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
    emit(...args) {
      for (const handler of [...handlers]) {
        try {
          const result = handler(...args);
          if (result && typeof result.then === 'function') {
            result.then(undefined, (err) => reportFailure(getLogger, label, err));
          }
        } catch (err) {
          reportFailure(getLogger, label, err);
        }
      }
    },
    /** How many handlers are subscribed (an owner that starts work for the first one). */
    size() {
      return handlers.size;
    },
  };
}
