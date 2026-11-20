/**
 * The one input validator (docs/TECH-STACK.md, Server): JSON Schema with ajv,
 * for every route's input and every MCP tool's arguments
 * (docs/specs/ERROR-HANDLING.md, Request validation).
 *
 * - Unknown keys are refused, never stripped: an object schema says which
 *   keys it takes (`additionalProperties: false`), and ajv removes nothing.
 * - JSON (a request body, a tool's arguments) is not coerced: a string is not
 *   a number. A querystring, params and headers arrive as strings, so those
 *   are coerced to the type their schema names.
 * - Strict: a schema ajv cannot read as written (an unknown keyword, a union
 *   type, `properties` without `type: 'object'`) fails at compile, so at boot.
 * - An object that takes keys it does not list says so on purpose
 *   (`openOnPurpose`); `npm run check` fails any other (routes/schemas.js,
 *   `routeSchemaProblems`).
 */
import Ajv from 'ajv';

/**
 * The annotation that marks a schema open on purpose: an object whose other
 * keys are its owner's to check (an app's config, a provider's callback
 * parameters), or a value any JSON may be (the MCP envelope, which its server
 * answers in JSON-RPC's terms). It changes no validation.
 */
export const OPEN_ON_PURPOSE = 'openOnPurpose';

/**
 * `schema` marked open on purpose; an object schema that gives no
 * `additionalProperties` takes any other key.
 */
export function openOnPurpose(schema = {}) {
  const isObject = [].concat(schema.type ?? []).includes('object');
  return {
    ...schema,
    ...(isObject && schema.additionalProperties === undefined ? { additionalProperties: true } : {}),
    [OPEN_ON_PURPOSE]: true,
  };
}

const COMMON_OPTIONS = {
  allErrors: false,
  removeAdditional: false,
  useDefaults: true,
  strict: true,
};

const jsonAjv = new Ajv({ ...COMMON_OPTIONS, coerceTypes: false });
const stringPartAjv = new Ajv({ ...COMMON_OPTIONS, coerceTypes: 'array' });
for (const ajv of [jsonAjv, stringPartAjv]) ajv.addKeyword({ keyword: OPEN_ON_PURPOSE, schemaType: 'boolean' });

/** Fastify's validator compiler (`setValidatorCompiler`): the request part picks the instance. */
export function compileRouteValidator({ schema, httpPart }) {
  return (httpPart === 'body' ? jsonAjv : stringPartAjv).compile(schema);
}

/**
 * A validator for JSON that is not a request body (an MCP tool's arguments):
 * returns `null` when `value` passes, else the first ajv error.
 */
export function compileJsonValidator(schema) {
  const validate = jsonAjv.compile(schema);
  return (value) => (validate(value) ? null : validate.errors[0]);
}
