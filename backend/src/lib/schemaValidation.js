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
 */
import Ajv from 'ajv';

const COMMON_OPTIONS = {
  allErrors: false,
  removeAdditional: false,
  useDefaults: true,
  strict: true,
};

const jsonAjv = new Ajv({ ...COMMON_OPTIONS, coerceTypes: false });
const stringPartAjv = new Ajv({ ...COMMON_OPTIONS, coerceTypes: 'array' });

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
