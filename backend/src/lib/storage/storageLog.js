/**
 * The storage module's logger, handed in at boot through the facade's
 * `configure({ logger })`; null until then.
 */
let logger = null;

export function setStorageLogger(next) {
  logger = next;
}

export function storageLogger() {
  return logger;
}
