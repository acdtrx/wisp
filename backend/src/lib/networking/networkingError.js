/**
 * Structured errors for the networking module: `{ code, message, raw? }` on an
 * Error, the shape every manager throws (CODING-RULES §5). Private to the
 * module so it carries no app-glue import; routes map the codes to HTTP status.
 */
export function networkingError(code, message, raw) {
  const err = new Error(message);
  err.code = code;
  if (raw) err.raw = raw;
  return err;
}
