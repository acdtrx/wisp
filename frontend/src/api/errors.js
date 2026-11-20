/**
 * The client's one error object (docs/specs/ERROR-HANDLING.md). The server
 * answers every failure, on every channel, as `{ error: <CODE>, detail }`;
 * the client turns it into an ApiError, and errors it makes itself (a
 * deadline, a job that is gone) are ApiErrors with their own code and no
 * status. Branch on `code`, show through `errorText`: never on message text.
 */
/**
 * The codes the client gives the errors it makes itself, never sent by the
 * server (docs/specs/ERROR-HANDLING.md, Client codes).
 */
export const CLIENT_CODES = Object.freeze({
  /** A REST call or an upload's reply past its deadline. */
  TIMEOUT: 'TIMEOUT',
  /** An error answer that is not the error body (a proxy's page, an empty body). */
  REQUEST_FAILED: 'REQUEST_FAILED',
  /** The browser could not send the upload. */
  UPLOAD_FAILED: 'UPLOAD_FAILED',
  /** The upload made no progress for its idle bound. */
  UPLOAD_STALLED: 'UPLOAD_STALLED',
  /** The upload was cancelled. */
  UPLOAD_CANCELLED: 'UPLOAD_CANCELLED',
  /** The server no longer knows the job a wait follows (it expired, or never existed). */
  JOB_GONE: 'JOB_GONE',
});

export class ApiError extends Error {
  /** @param {{ status?: number | null, code: string, detail?: string }} fields */
  constructor({ status = null, code, detail = '' }) {
    super(detail || code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/** An ApiError from a server error body; a body that is not one still fails, with REQUEST_FAILED. */
export function errorFromBody(body, status) {
  if (body && typeof body.error === 'string' && body.error) {
    return new ApiError({ status, code: body.error, detail: typeof body.detail === 'string' ? body.detail : '' });
  }
  return new ApiError({ status, code: CLIENT_CODES.REQUEST_FAILED, detail: `Request failed (${status})` });
}

const SESSION_LOST_CODES = new Set(['AUTH_REQUIRED', 'AUTH_INVALID']);

/** True when the error says the session is gone (none sent, or invalid or expired). */
export function isSessionLost(err) {
  return SESSION_LOST_CODES.has(err?.code);
}

const nonEmpty = (value) => (typeof value === 'string' && value ? value : null);

/**
 * The text to show for any error: an ApiError (a job row's error is one), a
 * plain Error, or an error frame / job event `{ error: <CODE>, detail }`.
 * Prefers the detail, then the message, then the code.
 */
export function errorText(err) {
  return nonEmpty(err?.detail) ?? nonEmpty(err?.message) ?? nonEmpty(err?.code) ?? nonEmpty(err?.error) ?? 'Unknown error';
}
