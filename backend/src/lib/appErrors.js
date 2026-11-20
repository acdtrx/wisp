/**
 * The one error path (docs/specs/ERROR-HANDLING.md). Code throws structured
 * errors (`createAppError`); every channel that carries one to a client — an
 * HTTP answer, a job's error event, a stream's error frame, an MCP tool error —
 * sends `errorBody(err)`: `{ error: <code>, detail: <message> }`, redacted
 * here and nowhere else. A code's HTTP status comes from the one table,
 * `errorCodes.js`.
 */
import { ERROR_STATUS } from './errorCodes.js';

/**
 * A structured error: `code` from the table, `message` for the reader, and an
 * optional `raw` cause (toolchain stderr, a daemon's message) that the detail
 * carries after the message.
 */
export function createAppError(code, message, raw) {
  const err = new Error(message);
  err.code = code;
  if (raw) err.raw = raw;
  return err;
}

/** The HTTP status of a code; 500 for a code the table does not hold. */
export function errorStatus(code) {
  return ERROR_STATUS[code] ?? 500;
}

/**
 * True for a code that answers 4xx — an ordinary state or input error
 * (VM_MUST_BE_OFFLINE, VM_BUSY…), not a fault. Job failure paths use it to
 * skip their error-level stack log: the job store's warn line already
 * records the failure.
 */
export function isExpectedAppError(err) {
  const status = ERROR_STATUS[err?.code];
  return status !== undefined && status < 500;
}

/** True for an error carrying a code from the table. */
export function isAppError(err) {
  return typeof err?.code === 'string' && ERROR_STATUS[err.code] !== undefined;
}

/**
 * `err` when it carries a code from the table; otherwise an INTERNAL_ERROR
 * whose message says what failed, the original message as its cause.
 */
export function asAppError(err, message) {
  return isAppError(err) ? err : createAppError('INTERNAL_ERROR', message, err?.message ?? String(err));
}

/* Fastify's own refusals, by its error code; the rest by the status it chose. */
const FRAMEWORK_CODES = {
  FST_ERR_CTP_BODY_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  FST_INVALID_MULTIPART_CONTENT_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  FST_REQ_FILE_TOO_LARGE: 'UPLOAD_TOO_LARGE',
  FST_PARTS_LIMIT: 'PAYLOAD_TOO_LARGE',
  FST_FILES_LIMIT: 'PAYLOAD_TOO_LARGE',
  FST_FIELDS_LIMIT: 'PAYLOAD_TOO_LARGE',
};
const FRAMEWORK_CODES_BY_STATUS = {
  404: 'ROUTE_NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  413: 'PAYLOAD_TOO_LARGE',
  414: 'URI_TOO_LONG',
  415: 'UNSUPPORTED_MEDIA_TYPE',
};

/** `body/vlanId must be number`; an unknown key is named. */
function validationMessage(err) {
  const part = err.validationContext || 'request';
  const first = Array.isArray(err.validation) ? err.validation[0] : null;
  if (!first) return `${part}: ${err.message}`;
  const where = `${part}${first.instancePath || ''}`;
  if (first.keyword === 'additionalProperties' && first.params?.additionalProperty) {
    return `${where}: unknown key "${first.params.additionalProperty}"`;
  }
  return `${where} ${first.message}`;
}

/**
 * The code and message any thrown value answers with. A code the table holds
 * is kept; Fastify's refusals get theirs; anything else is INTERNAL_ERROR.
 * @returns {{ code: string, message: string, raw?: string }}
 */
function classify(err) {
  const message = typeof err?.message === 'string' && err.message ? err.message : String(err ?? 'Unknown error');
  if (isAppError(err)) {
    return { code: err.code, message, raw: typeof err.raw === 'string' ? err.raw : undefined };
  }
  if (err?.validation) return { code: 'VALIDATION_FAILED', message: validationMessage(err) };
  if (typeof err?.code === 'string' && FRAMEWORK_CODES[err.code]) {
    return { code: FRAMEWORK_CODES[err.code], message };
  }
  const status = err?.statusCode;
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    return { code: FRAMEWORK_CODES_BY_STATUS[status] ?? 'BAD_REQUEST', message };
  }
  return { code: 'INTERNAL_ERROR', message };
}

/*
 * An absolute path starts a token: at the start, after whitespace, a quote, a
 * bracket, `=` or `,`. A slash inside a word is not one: image refs
 * (`docker.io/library/nginx`), URLs, `body/field` and ratios pass untouched.
 * Punctuation that ends the sentence (`/x/y: busy`) is not part of the path.
 * Wisp's own URL space (`/api/…`, `/ws/…`, `/mcp`) is not host layout and
 * stays readable.
 */
const ABS_PATH_RE = /(^|[\s'"`(\[{=,])\/[^\s'"`)\]},]*[^\s'"`)\]},:;.!?]/g;
const URL_SPACE_RE = /^\/(?:api|ws|mcp)(?:[/?#]|$)/;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const DETAIL_MAX = 500;

/**
 * Host layout (absolute paths) and libvirt UUIDs from toolchain output stay
 * in the server log; the client gets placeholders. Capped in length.
 */
export function redactDetail(text) {
  let s = String(text)
    .replace(ABS_PATH_RE, (match, lead) => (URL_SPACE_RE.test(match.slice(lead.length)) ? match : `${lead}<path>`))
    .replace(UUID_RE, '<uuid>');
  if (s.length > DETAIL_MAX) s = `${s.slice(0, DETAIL_MAX)}…`;
  return s;
}

/** The message, then the raw cause when it says something the message doesn't. */
function detailText({ message, raw }) {
  if (!raw || raw === message || message.includes(raw)) return message;
  return `${message}: ${raw}`;
}

/**
 * The error as every channel sends it: `{ error: <code>, detail }`, redacted.
 * @returns {{ error: string, detail: string }}
 */
export function errorBody(err) {
  const c = classify(err);
  return { error: c.code, detail: redactDetail(detailText(c)) };
}

/** `errorBody` with the HTTP status its code answers. */
export function errorAnswer(err) {
  const body = errorBody(err);
  return { status: errorStatus(body.error), body };
}

/**
 * Fastify's error handler (`setErrorHandler` and `frameworkErrors`): routes,
 * hooks and the framework throw; this answers. Faults are logged at error
 * with the unredacted error; an expected error whose raw cause the client
 * sees only redacted is logged at warn.
 */
export function handleRequestError(err, request, reply) {
  const { status, body } = errorAnswer(err);
  if (status >= 500) {
    request.log.error({ err, code: body.error }, 'Request failed');
  } else if (err?.raw) {
    request.log.warn({ err: err.message, code: body.error, raw: err.raw }, 'Request refused');
  }
  reply.code(status).send(body);
}
