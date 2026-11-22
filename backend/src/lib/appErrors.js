/**
 * The one error path (docs/specs/ERROR-HANDLING.md). Code throws structured
 * errors (`createAppError`); every channel that carries one to a client — an
 * HTTP answer, a job's error event, a stream's error frame, an MCP tool error —
 * sends `errorBody(err)`: `{ error: <code>, detail }`, the detail built and
 * its cause redacted here and nowhere else. A code's HTTP status comes from
 * the one table, `errorCodes.js`.
 */
import { ERROR_STATUS } from './errorCodes.js';

/**
 * The mark of an error a Wisp factory built, its message Wisp's own words:
 * createAppError's, and those of the managers' and the networking module's
 * private factories, which cannot import this module and set the same
 * registry symbol. The one test of "Wisp's own words" (isAppError), set only
 * by the factories: an error built by hand with a code is not one. Not
 * enumerable: neither the log nor a body shows it.
 */
const WISP_ERROR = Symbol.for('wisp.error');

/**
 * A structured error: `code` from the table, `message` for the reader, and an
 * optional `raw` cause (toolchain stderr, a daemon's message) that the detail
 * carries after the message.
 */
export function createAppError(code, message, raw) {
  const err = new Error(message);
  err.code = code;
  if (raw) err.raw = raw;
  Object.defineProperty(err, WISP_ERROR, { value: true });
  return err;
}

/**
 * The error that says `message` about the failures `inners`
 * (docs/specs/ERROR-HANDLING.md → The error body): an app error's message is
 * Wisp's words, so it joins the outer message whole, and its raw cause is the
 * raw cause; any other error's text is all cause. Several inners join with
 * `; ` in each part. The one way to wrap an error in glue; the managers,
 * which cannot import this module, have their twins beside their factories.
 */
export function wrapAppError(code, message, ...inners) {
  const messages = [];
  const raws = [];
  for (const inner of inners) {
    if (isAppError(inner)) {
      messages.push(inner.message);
      if (inner.raw) raws.push(inner.raw);
    } else {
      raws.push(inner?.message || String(inner));
    }
  }
  return createAppError(code, messages.length ? `${message}: ${messages.join('; ')}` : message, raws.join('; '));
}

/**
 * The refusal of a delete whose in-use check could not read what it checks:
 * the failed read's own code (a manager's `NO_CONNECTION`, `NO_CONTAINERD`, …),
 * its error the cause — never "nobody uses it".
 */
export function inUseCheckFailed(what, err) {
  return wrapAppError(isAppError(err) ? err.code : 'INTERNAL_ERROR', `Cannot tell whether ${what} is in use`, err);
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
  return isAppError(err) && status !== undefined && status < 500;
}

/** True for an error a Wisp factory built (the mark): its message is Wisp's own words. */
export function isAppError(err) {
  return err?.[WISP_ERROR] === true;
}

/**
 * `err` when a Wisp factory built it; otherwise an INTERNAL_ERROR whose
 * message says what failed, the original message as its cause.
 */
export function asAppError(err, message) {
  return isAppError(err) ? err : createAppError('INTERNAL_ERROR', message, err?.message ?? String(err));
}

/*
 * The framework's refusals that can reach the handler in this app, by their
 * error code (Fastify's and @fastify/multipart's). Fastify answers no request
 * timeout here (`requestTimeout` is not set), so there is no 408. A 4xx not
 * listed becomes BAD_REQUEST, a 5xx INTERNAL_ERROR.
 */
const FRAMEWORK_CODES = {
  FST_ERR_CTP_INVALID_JSON_BODY: 'MALFORMED_JSON',
  FST_ERR_CTP_EMPTY_JSON_BODY: 'MALFORMED_JSON',
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: 'BAD_CONTENT_LENGTH',
  FST_ERR_BAD_URL: 'MALFORMED_URL',
  FST_PROTO_VIOLATION: 'MALFORMED_MULTIPART',
  FST_MP_PREMATURE_CLOSE: 'MALFORMED_MULTIPART',
  FST_ERR_CTP_BODY_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  FST_PARTS_LIMIT: 'PAYLOAD_TOO_LARGE',
  FST_FILES_LIMIT: 'PAYLOAD_TOO_LARGE',
  FST_FIELDS_LIMIT: 'PAYLOAD_TOO_LARGE',
  FST_REQ_FILE_TOO_LARGE: 'UPLOAD_TOO_LARGE',
  FST_ERR_MAX_PARAM_LENGTH: 'URI_TOO_LONG',
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  FST_INVALID_MULTIPART_CONTENT_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  FST_ERR_NOT_FOUND: 'ROUTE_NOT_FOUND',
};

/** `body/vlanId must be number` from one ajv error of `part`; an unknown key is named. */
function schemaErrorMessage(part, first) {
  const where = `${part}${first.instancePath || ''}`;
  if (first.keyword === 'additionalProperties' && first.params?.additionalProperty) {
    return `${where}: unknown key "${first.params.additionalProperty}"`;
  }
  return `${where} ${first.message}`;
}

function validationMessage(err) {
  const part = err.validationContext || 'request';
  const first = Array.isArray(err.validation) ? err.validation[0] : null;
  return first ? schemaErrorMessage(part, first) : `${part}: ${err.message}`;
}

/**
 * The VALIDATION_FAILED error for input that failed its schema outside a
 * route (an MCP tool's arguments): `part` names the input, as `body` does on
 * HTTP; `failure` is the validator's first finding, worded from Wisp's schema.
 */
export function schemaValidationError(part, failure) {
  return createAppError('VALIDATION_FAILED', schemaErrorMessage(part, failure));
}

/**
 * The code, the message and the cause any thrown value answers with. An app
 * error (the mark) keeps its code, which the table maps to its status; its
 * message is Wisp's own text, its `raw` the cause. A marked error whose code
 * the table lacks (a bug `npm run check` catches) answers INTERNAL_ERROR, its
 * message still Wisp's. A framework refusal gets its code, its message
 * Fastify's (built from Wisp's schemas and limits). Anything else is
 * INTERNAL_ERROR, and its text, which Wisp did not write, is all cause.
 * @returns {{ code: string, message: string, cause?: string }}
 */
function classify(err) {
  const text = typeof err?.message === 'string' && err.message ? err.message : String(err ?? 'Unknown error');
  if (isAppError(err)) {
    const cause = typeof err.raw === 'string' && err.raw ? err.raw : undefined;
    const code = ERROR_STATUS[err.code] !== undefined ? err.code : 'INTERNAL_ERROR';
    return { code, message: text, cause };
  }
  if (err?.validation) return { code: 'VALIDATION_FAILED', message: validationMessage(err) };
  if (typeof err?.code === 'string' && FRAMEWORK_CODES[err.code]) {
    return { code: FRAMEWORK_CODES[err.code], message: text };
  }
  const status = err?.statusCode;
  if (Number.isInteger(status) && status >= 400 && status < 500) return { code: 'BAD_REQUEST', message: text };
  return { code: 'INTERNAL_ERROR', message: '', cause: text };
}

/*
 * An absolute path starts a token: at the start, after whitespace, a quote, a
 * bracket, or one of `= , : ; < |` — so `file:/var/x`, `path</var/x>` and
 * `see|/etc/x` are caught. Two slashes start a URL's host or an SMB share, not
 * a path, and a slash inside a word is not one: URLs, image refs
 * (`docker.io/library/nginx`) and `body/field` pass untouched. Punctuation
 * that ends the sentence (`/x/y: busy`) is not part of the path. Wisp's own URL
 * space (`/api/…`, `/ws/…`, `/mcp`) is not host layout and stays readable. An
 * unquoted path with a space keeps what follows the space: nothing marks where
 * such a path ends.
 */
const ABS_PATH_RE = /(^|[\s'"`(\[{=,:;<|])\/(?!\/)[^\s'"`)\]}>,|]*[^\s'"`)\]}>,|:;.!?]/g;
const URL_SPACE_RE = /^\/(?:api|ws|mcp)(?:[/?#]|$)/;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const DETAIL_MAX = 500;

/**
 * Host layout (absolute paths) and libvirt UUIDs in a cause — text from a tool
 * or a library Wisp does not control — stay in the server log; the client gets
 * placeholders.
 */
export function redactCause(text) {
  return String(text)
    .replace(ABS_PATH_RE, (match, lead) => (URL_SPACE_RE.test(match.slice(lead.length)) ? match : `${lead}<path>`))
    .replace(UUID_RE, '<uuid>');
}

/**
 * The detail: Wisp's message, whole — it names what the operator needs (a
 * mount path they typed, a share, a destination) — then the redacted cause
 * when it says something the message doesn't. Capped in length.
 */
function detailText({ message, cause }) {
  let s = message;
  if (cause && cause !== message && !message.includes(cause)) {
    s = message ? `${message}: ${redactCause(cause)}` : redactCause(cause);
  }
  if (s.length > DETAIL_MAX) s = `${s.slice(0, DETAIL_MAX)}…`;
  return s;
}

/**
 * The error as every channel sends it: `{ error: <code>, detail }`.
 * @returns {{ error: string, detail: string }}
 */
export function errorBody(err) {
  const c = classify(err);
  return { error: c.code, detail: detailText(c) };
}

/** `errorBody` with the HTTP status its code answers. */
export function errorAnswer(err) {
  const body = errorBody(err);
  return { status: errorStatus(body.error), body };
}

/** Headers that describe a success body, dropped when an error answers instead. */
const SUCCESS_ONLY_HEADERS = ['content-type', 'content-disposition', 'content-length', 'content-encoding'];

/**
 * Fastify's error handler (`setErrorHandler` and `frameworkErrors`): routes,
 * hooks and the framework throw; this answers. A 5xx is logged at `error` with
 * the whole error, and a 4xx that has a raw cause at `warn` with it.
 */
export function handleRequestError(err, request, reply) {
  const { status, body } = errorAnswer(err);
  if (status >= 500) {
    request.log.error({ err, code: body.error }, 'Request failed');
  } else if (err?.raw) {
    request.log.warn({ err: err.message, code: body.error, raw: err.raw }, 'Request refused');
  }
  // Once the headers are out (a download that failed mid-transfer), no answer
  // can follow: Fastify ends the response and the client sees it cut short.
  if (reply.raw.headersSent) return;
  // A route that set the headers of its success (a download's type and file
  // name) before it failed answers the error as JSON all the same.
  for (const name of SUCCESS_ONLY_HEADERS) reply.removeHeader(name);
  reply.code(status).type('application/json; charset=utf-8').send(body);
}
