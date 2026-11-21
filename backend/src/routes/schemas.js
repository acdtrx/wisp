/**
 * The route schemas more than one route file uses, the boundary every route
 * gets (`completeRouteSchema`), and the rules `npm run check` holds each
 * route's declaration to (`routeSchemaProblems`; docs/specs/API.md, Errors).
 */
import { OPEN_ON_PURPOSE } from '../lib/schemaValidation.js';
import { containerNameSchema, runIdSchema, vmNameSchema } from '../lib/validation.js';

/** Every error answer, on every route (docs/specs/ERROR-HANDLING.md, The error body). */
export const errorBodySchema = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    detail: { type: 'string' },
  },
  additionalProperties: false,
};

/** A 204: no body. */
export const noContentSchema = { type: 'null' };

/** The ack of a create that assigns the new record's id; the record arrives on its topic. */
export const createdIdSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string' } },
  additionalProperties: false,
};

/** `:id` of a stored record (a section, a home-page group or tile, a host mount, an API token). */
export const idParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1 } },
  additionalProperties: false,
};

/** `:name` of a VM, plus the route's other params. */
export function vmParamsSchema(otherParams = {}) {
  return {
    type: 'object',
    required: ['name', ...Object.keys(otherParams)],
    properties: { name: vmNameSchema, ...otherParams },
    additionalProperties: false,
  };
}

/** `:name` of a container, plus the route's other params. */
export function containerParamsSchema(otherParams = {}) {
  return {
    type: 'object',
    required: ['name', ...Object.keys(otherParams)],
    properties: { name: containerNameSchema, ...otherParams },
    additionalProperties: false,
  };
}

/** A container run's id: the run-log download's param and the logs stream's query. */
export { runIdSchema };

/** The workload a job acts on, `null` for a job on none. */
export const jobSubjectSchema = {
  type: ['object', 'null'],
  required: ['type', 'name'],
  properties: {
    type: { type: 'string', enum: ['vm', 'container'] },
    name: { type: 'string' },
  },
  additionalProperties: false,
};

/** A job route's 202 body: the job it started, or the running one it joined (docs/specs/API.md, Background jobs). */
export const jobAckSchema = {
  type: 'object',
  required: ['jobId', 'kind', 'title', 'subject'],
  properties: {
    jobId: { type: 'string' },
    kind: { type: 'string' },
    title: { type: 'string' },
    subject: jobSubjectSchema,
  },
  additionalProperties: false,
};

/** A backup's body: the destinations to write (`local`, the backup mount's id); none means the defaults. */
export const backupBodySchema = {
  type: 'object',
  properties: {
    destinationIds: { type: 'array', items: { type: 'string', minLength: 1 } },
  },
  additionalProperties: false,
};

/*
 * A VM's cloud-init settings, as saved and as read back. `password` reads back
 * as `set` or `''`, never the value. `sshKey` is the VM's own copy of its keys, one
 * per line.
 */
const cloudInitFields = {
  enabled: { type: 'boolean' },
  // RFC 1123 hostname label (1–63 chars, alphanumerics + hyphen, no leading/trailing hyphen).
  hostname: { type: 'string', maxLength: 63, pattern: '^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$' },
  username: { type: 'string', maxLength: 32, pattern: '^[a-z][a-z0-9_-]{0,31}$' },
  // Password is opaque to validation (we hash it). Forbid CR/LF so user input cannot extend the cloud-init document mid-scalar (defense in depth — js-yaml escaping already handles it). Empty string allowed; '***' / 'set' are placeholders.
  password: { type: 'string', maxLength: 256, pattern: '^[^\\r\\n]*$' },
  // SSH key may be one or more lines (e.g. several keys joined by \n). Length-cap to keep the user-data ISO bounded.
  sshKey: { type: 'string', maxLength: 16384 },
  growPartition: { type: 'boolean' },
  packageUpgrade: { type: 'boolean' },
  installQemuGuestAgent: { type: 'boolean' },
  installAvahiDaemon: { type: 'boolean' },
};

/** The `cloudInit` of a VM create, the cloud-init PUT's body and its GET's answer. */
export const cloudInitSchema = {
  type: 'object',
  properties: cloudInitFields,
  additionalProperties: false,
};

/*
 * A host mount as the API shows it (GET /api/host/mounts and the settings'
 * `mounts`). The stored `password` is not listed, so it never leaves the
 * server: `mountForApi` (lib/settings.js) gives `hasPassword` instead.
 */
export const mountResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    type: { type: 'string' },
    label: { type: 'string' },
    mountPath: { type: 'string' },
    autoMount: { type: 'boolean' },
    share: { type: 'string' },
    username: { type: 'string' },
    hasPassword: { type: 'boolean' },
    uuid: { type: 'string' },
    fsType: { type: 'string' },
    readOnly: { type: 'boolean' },
  },
  additionalProperties: false,
};

/**
 * What a route answers instead of a JSON body (`config: { answers }`): the
 * check demands no response schema of it.
 */
export const ANSWER_KINDS = ['sse', 'websocket', 'download', 'redirect', 'mcp'];

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** A route that declares no querystring takes none. */
const NO_QUERYSTRING = { type: 'object', additionalProperties: false };

/** A command that declares no body takes none: an empty object, or nothing. */
const NO_BODY = { type: 'object', nullable: true, additionalProperties: false };

/**
 * `onRoute`: what every route of the app gets, whatever it declares. An input
 * part it does not declare accepts nothing, so a key a route forgot to declare
 * is refused, never read unchecked; and every error answers the one error body.
 * Routes a third-party plugin adds (`config.pluginRoute`) keep their own.
 */
export function completeRouteSchema(routeOptions) {
  if (routeOptions.config?.pluginRoute) return;
  const schema = routeOptions.schema ?? {};
  const methods = [].concat(routeOptions.method);
  routeOptions.schema = {
    ...schema,
    querystring: schema.querystring ?? NO_QUERYSTRING,
    ...(methods.some((m) => BODY_METHODS.has(m)) ? { body: schema.body ?? NO_BODY } : {}),
    response: { '4xx': errorBodySchema, '5xx': errorBodySchema, ...schema.response },
  };
}

/** `:name` and `*` of a route URL. */
function urlParams(url) {
  const names = [...url.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]);
  return url.includes('*') ? [...names, '*'] : names;
}

/** Keywords that constrain a value without naming its `type`. */
const TYPELESS_CONSTRAINTS = ['enum', 'const', 'anyOf', 'oneOf', 'allOf', 'not', 'if', '$ref'];

/** Keywords whose value is one schema, an array of schemas, or a map of name → schema. */
const ONE_SCHEMA = ['additionalProperties', 'additionalItems', 'contains', 'propertyNames', 'if', 'then', 'else', 'not',
  'unevaluatedProperties', 'unevaluatedItems'];
const SCHEMA_LISTS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
const SCHEMA_MAPS = ['properties', 'patternProperties', 'dependentSchemas', 'dependencies', '$defs', 'definitions'];

/** The schema a local `$ref` (`#/…`, a JSON pointer into `root`) names; undefined for any other. */
function resolveLocalRef(root, ref) {
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) return undefined;
  let node = root;
  for (const token of ref.slice(2).split('/')) {
    const key = decodeURIComponent(token).replaceAll('~1', '/').replaceAll('~0', '~');
    if (!node || typeof node !== 'object' || !Object.hasOwn(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

/** Each sub-schema of `schema`, with the path the report names it by. */
function subSchemas(schema, path) {
  const subs = [];
  for (const key of SCHEMA_MAPS) {
    // `properties` keeps its plain path (`/name`); `dependencies` lists names as well as schemas.
    const prefix = key === 'properties' ? path : `${path}/${key}`;
    for (const [name, sub] of Object.entries(schema[key] ?? {})) {
      if (!Array.isArray(sub)) subs.push([sub, `${prefix}/${name}`]);
    }
  }
  for (const key of ONE_SCHEMA) {
    const sub = schema[key];
    // A boolean `additionalProperties` is the object's own rule, checked above.
    if (sub === undefined || (key === 'additionalProperties' && typeof sub === 'boolean')) continue;
    subs.push([sub, key === 'additionalProperties' ? `${path}/*` : `${path}/${key}`]);
  }
  if (Array.isArray(schema.items)) schema.items.forEach((sub, i) => subs.push([sub, `${path}/[${i}]`]));
  else if (schema.items !== undefined) subs.push([schema.items, `${path}/[]`]);
  for (const key of SCHEMA_LISTS) {
    for (const [i, sub] of (schema[key] ?? []).entries()) subs.push([sub, `${path}/${key}[${i}]`]);
  }
  return subs;
}

/**
 * What is wrong with each schema in `schema`, by its path, descending into every
 * keyword that holds a schema and into the local `$ref`s it uses: an object
 * that takes keys it does not list (`additionalProperties` other than `false`),
 * or lists none (`properties` missing), and an array that does not say its
 * `items`, unless marked open on purpose (`openOnPurpose`); a schema that lists
 * `properties` without `type: 'object'`; a schema that says nothing at all of
 * its value (`true` included); a `$ref` the check cannot follow. A marked
 * schema's own sub-schemas are still checked.
 */
function objectProblems(schema, path, root = schema, followed = new Set()) {
  const at = path || '/';
  if (schema === true) return [`${at} has no type`];
  if (!schema || typeof schema !== 'object') return [];
  const found = [];
  const types = [].concat(schema.type ?? []);
  const open = schema[OPEN_ON_PURPOSE] === true;
  if (types.length === 0 && !open) {
    if (schema.properties) found.push(`${at} lists properties without type 'object'`);
    else if (!TYPELESS_CONSTRAINTS.some((k) => schema[k] !== undefined)) found.push(`${at} has no type`);
  }
  if (types.includes('object') && !open) {
    if (schema.additionalProperties !== false) found.push(`${at} takes unlisted keys and is not marked openOnPurpose`);
    else if (!schema.properties) found.push(`${at} lists no properties`);
  }
  if (types.includes('array') && !open && schema.items === undefined) {
    found.push(`${at} does not say its items and is not marked openOnPurpose`);
  }
  for (const [sub, subPath] of subSchemas(schema, path)) found.push(...objectProblems(sub, subPath, root, followed));
  if (typeof schema.$ref === 'string') {
    const target = resolveLocalRef(root, schema.$ref);
    if (target === undefined) found.push(`${at} has a $ref the check cannot follow: ${schema.$ref}`);
    else if (!followed.has(schema.$ref)) {
      found.push(...objectProblems(target, `${path}/$ref(${schema.$ref})`, root, new Set([...followed, schema.$ref])));
    }
  }
  return found;
}

/**
 * A route's declared schemas as the report shows them, and what they lack:
 * params naming every URL param; every object of its input and of its answers
 * listing the keys it takes, unless marked open on purpose (`openOnPurpose`,
 * lib/schemaValidation.js); a response schema for a 2xx, unless the route
 * answers a stream, a file, a redirect or MCP (`config.answers`).
 * @param {{ method: string, url: string, declaredSchema?: object, config?: object, websocket?: boolean }} route
 */
export function routeSchemaProblems({ url, declaredSchema, config, websocket }) {
  const schema = declaredSchema ?? {};
  const problems = [];
  const answers = config?.answers;
  if (answers !== undefined && !ANSWER_KINDS.includes(answers)) {
    problems.push(`unknown config.answers ${JSON.stringify(answers)}`);
  }
  if (websocket && answers !== 'websocket') problems.push('a WebSocket route needs config.answers \'websocket\'');
  if (!websocket && answers === 'websocket') problems.push('config.answers \'websocket\' on a route that is not one');
  const params = urlParams(url);
  if (params.length > 0) {
    const declared = Object.keys(schema.params?.properties ?? {});
    const missing = params.filter((p) => !declared.includes(p));
    if (!schema.params) problems.push('no params schema');
    else if (missing.length > 0) problems.push(`params schema lacks ${missing.join(', ')}`);
  }
  for (const part of ['params', 'querystring', 'body']) {
    for (const problem of objectProblems(schema[part], '')) problems.push(`${part}${problem.startsWith('/ ') ? problem.slice(1) : problem}`);
  }
  for (const [code, response] of Object.entries(schema.response ?? {})) {
    for (const problem of objectProblems(response, '')) problems.push(`response ${code}${problem.startsWith('/ ') ? problem.slice(1) : problem}`);
  }
  const successCodes = Object.keys(schema.response ?? {}).filter((code) => /^2/.test(code));
  if (answers === undefined && successCodes.length === 0) problems.push('no response schema for a 2xx');
  return problems;
}

/** The report's summary of a route's declared schemas: `params query body → answers`. */
export function routeSchemaSummary({ declaredSchema, config }) {
  const schema = declaredSchema ?? {};
  const mark = (part) => (schema[part] ? part : '-'.repeat(part.length));
  const successCodes = Object.keys(schema.response ?? {}).filter((code) => /^2/.test(code));
  const answers = config?.answers ?? (successCodes.join(',') || '?');
  return `${mark('params')} ${mark('querystring')} ${mark('body')} → ${answers}`;
}
