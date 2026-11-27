import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compileJsonValidator, openOnPurpose } from '../lib/schemaValidation.js';
import { routeSchemaProblems } from './schemas.js';

const closed = (properties = { a: { type: 'string' } }) => ({ type: 'object', properties, additionalProperties: false });

/** The problems of a GET /x route declaring `schema`, with a 200 unless it gives its own responses. */
const problems = (schema) => routeSchemaProblems({
  method: 'GET', url: '/x', declaredSchema: { response: { 200: closed() }, ...schema },
});

test('a closed object with its properties, in each part, passes', () => {
  assert.deepEqual(problems({ querystring: closed(), body: closed(), response: { 200: closed(), 202: closed() } }), []);
});

test('an object that takes keys it does not list fails, in a request part and in a response', () => {
  const unsaid = { type: 'object', properties: { a: { type: 'string' } } };
  const open = { ...unsaid, additionalProperties: true };
  const map = { type: 'object', additionalProperties: { type: 'string' } };
  for (const schema of [unsaid, open, map]) {
    assert.deepEqual(problems({ body: schema }), ['body takes unlisted keys and is not marked openOnPurpose']);
    assert.deepEqual(problems({ querystring: schema }), ['querystring takes unlisted keys and is not marked openOnPurpose']);
    assert.deepEqual(problems({ response: { 200: schema } }), ['response 200 takes unlisted keys and is not marked openOnPurpose']);
  }
});

test('a nullable object is an object: open, it fails', () => {
  const schema = { type: ['object', 'null'], properties: { a: { type: 'string' } } };
  assert.deepEqual(problems({ response: { 200: schema } }), ['response 200 takes unlisted keys and is not marked openOnPurpose']);
});

test('an open object nested in properties, items, a map\'s values or a branch fails, named by its path', () => {
  const open = { type: 'object', properties: { b: { type: 'string' } } };
  const response = closed({
    list: { type: 'array', items: closed({ inner: open }) },
    tuple: { type: 'array', items: [open] },
    byName: openOnPurpose({ type: 'object', additionalProperties: open }),
    either: { anyOf: [{ type: 'null' }, open] },
  });
  assert.deepEqual(problems({ response: { 200: response } }), [
    'response 200/list/[]/inner takes unlisted keys and is not marked openOnPurpose',
    'response 200/tuple/[0] takes unlisted keys and is not marked openOnPurpose',
    'response 200/byName/* takes unlisted keys and is not marked openOnPurpose',
    'response 200/either/anyOf[1] takes unlisted keys and is not marked openOnPurpose',
  ]);
});

test('an object with no properties fails, even closed; an explicit empty list passes', () => {
  assert.deepEqual(problems({ body: { type: 'object', additionalProperties: false } }), ['body lists no properties']);
  assert.deepEqual(problems({ response: { 200: { type: 'object', additionalProperties: false } } }), ['response 200 lists no properties']);
  assert.deepEqual(problems({ body: closed({}) }), []);
});

test('an untyped schema fails: one that says nothing, and properties without type object', () => {
  assert.deepEqual(problems({ body: {} }), ['body has no type']);
  assert.deepEqual(problems({ body: closed({ x: { description: 'anything' } }) }), ['body/x has no type']);
  assert.deepEqual(
    problems({ response: { 200: { properties: { a: { type: 'string' } }, additionalProperties: false } } }),
    ["response 200 lists properties without type 'object'"],
  );
});

test('a value constrained without a type passes: enum, const, a union of branches', () => {
  const response = closed({ e: { enum: ['a', 'b'] }, c: { const: 1 }, u: { anyOf: [{ type: 'string' }, { type: 'null' }] } });
  assert.deepEqual(problems({ response: { 200: response } }), []);
});

test('a schema marked open on purpose passes: an object, a typed map, any value', () => {
  const marked = [
    openOnPurpose({ type: 'object', properties: { a: { type: 'string' } } }),
    openOnPurpose({ type: 'object', additionalProperties: { type: 'string' } }),
    openOnPurpose({ type: 'object' }),
    openOnPurpose(),
  ];
  for (const schema of marked) {
    assert.deepEqual(problems({ body: schema }), [], JSON.stringify(schema));
    assert.deepEqual(problems({ response: { 200: schema } }), [], JSON.stringify(schema));
  }
});

test('the properties a marked object lists are still checked', () => {
  const schema = openOnPurpose({ type: 'object', properties: { inner: { type: 'object', properties: {} } } });
  assert.deepEqual(problems({ body: schema }), ['body/inner takes unlisted keys and is not marked openOnPurpose']);
});

test('params are checked like the other parts', () => {
  const res = routeSchemaProblems({
    method: 'GET', url: '/x/:id',
    declaredSchema: { params: { type: 'object', properties: { id: { type: 'string' } } }, response: { 200: closed() } },
  });
  assert.deepEqual(res, ['params takes unlisted keys and is not marked openOnPurpose']);
});

test('openOnPurpose opens an object that says nothing of other keys, keeps a typed map, and validates as before', () => {
  assert.equal(openOnPurpose({ type: 'object' }).additionalProperties, true);
  const map = openOnPurpose({ type: 'object', additionalProperties: { type: 'string' } });
  assert.deepEqual(map.additionalProperties, { type: 'string' });
  // The strict validator takes the keyword, and it changes nothing it checks.
  const validate = compileJsonValidator(closed({ m: map, any: openOnPurpose() }));
  assert.equal(validate({ m: { k: 'v' }, any: [1, 'x'] }), null);
  assert.equal(validate({ m: { k: 1 } })?.instancePath, '/m/k');
});

/* ── The check descends into every keyword that holds a schema ──────── */

const OPEN = { type: 'object', properties: { b: { type: 'string' } } };
const unlisted = (path) => `body${path} takes unlisted keys and is not marked openOnPurpose`;

test('an open object under if, then, else or not fails, named by its keyword', () => {
  const body = { ...closed(), if: OPEN, then: OPEN, else: OPEN };
  assert.deepEqual(problems({ body }), [unlisted('/if'), unlisted('/then'), unlisted('/else')]);
  assert.deepEqual(problems({ body: { ...closed(), not: OPEN } }), [unlisted('/not')]);
});

test('an open object in allOf, anyOf or oneOf fails, named by its branch', () => {
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    assert.deepEqual(problems({ body: { [key]: [closed(), OPEN] } }), [unlisted(`/${key}[1]`)], key);
  }
});

test('an open object under patternProperties, dependentSchemas, dependencies or $defs fails', () => {
  const map = (key) => openOnPurpose({ type: 'object', [key]: { '^x': OPEN } });
  assert.deepEqual(problems({ body: map('patternProperties') }), [unlisted('/patternProperties/^x')]);
  assert.deepEqual(problems({ body: map('dependentSchemas') }), [unlisted('/dependentSchemas/^x')]);
  assert.deepEqual(problems({ body: map('$defs') }), [unlisted('/$defs/^x')]);
  // `dependencies` holds key lists as well as schemas: only a schema is checked.
  const deps = openOnPurpose({ type: 'object', dependencies: { a: ['b'], c: OPEN } });
  assert.deepEqual(problems({ body: deps }), [unlisted('/dependencies/c')]);
});

test('an open object under prefixItems, items, additionalItems or contains fails', () => {
  const list = (key) => closed({ l: { type: 'array', items: { type: 'string' }, [key]: key === 'prefixItems' ? [OPEN] : OPEN } });
  assert.deepEqual(problems({ body: list('prefixItems') }), [unlisted('/l/prefixItems[0]')]);
  assert.deepEqual(problems({ body: list('additionalItems') }), [unlisted('/l/additionalItems')]);
  assert.deepEqual(problems({ body: list('contains') }), [unlisted('/l/contains')]);
  assert.deepEqual(problems({ body: closed({ l: { type: 'array', items: OPEN } }) }), [unlisted('/l/[]')]);
});

test('an array that does not say its items fails, unless marked open on purpose', () => {
  assert.deepEqual(problems({ body: closed({ l: { type: 'array' } }) }), ['body/l does not say its items and is not marked openOnPurpose']);
  assert.deepEqual(problems({ response: { 200: { type: ['array', 'null'] } } }), ['response 200 does not say its items and is not marked openOnPurpose']);
  assert.deepEqual(problems({ body: closed({ l: { type: 'array', prefixItems: [{ type: 'string' }] } }) }),
    ['body/l does not say its items and is not marked openOnPurpose']);
  assert.deepEqual(problems({ body: closed({ l: openOnPurpose({ type: 'array' }) }) }), []);
  assert.deepEqual(problems({ body: closed({ l: { type: 'array', items: { type: 'string' } } }) }), []);
});

test('a sub-schema of true says nothing of its value and fails', () => {
  assert.deepEqual(problems({ body: closed({ l: { type: 'array', items: true } }) }), ['body/l/[] has no type']);
});

test('a local $ref is followed and its target checked; one the check cannot follow fails', () => {
  const body = { ...closed({ a: { $ref: '#/$defs/open' }, b: { $ref: '#/$defs/fine' } }), $defs: { open: OPEN, fine: closed() } };
  assert.deepEqual(problems({ body }), [unlisted('/a/$ref(#/$defs/open)'), unlisted('/$defs/open')]);
  assert.deepEqual(problems({ body: closed({ a: { $ref: 'shared#/thing' } }) }), ['body/a has a $ref the check cannot follow: shared#/thing']);
  assert.deepEqual(problems({ body: closed({ a: { $ref: '#/$defs/missing' } }) }), ['body/a has a $ref the check cannot follow: #/$defs/missing']);
  // A $ref back to the root is followed once, not forever.
  assert.deepEqual(problems({ body: closed({ self: { $ref: '#' } }) }), []);
});

test('propertyNames and the unevaluated keywords are descended into too', () => {
  const body = openOnPurpose({ type: 'object', propertyNames: { maxLength: 3 }, unevaluatedProperties: OPEN });
  assert.deepEqual(problems({ body }), ['body/propertyNames has no type', unlisted('/unevaluatedProperties')]);
});

/* ── The keys an agent route refuses ─────────────────────────────────── */

test('agentRefuses names keys of the body, and keys inside its objects and lists by path', () => {
  const body = closed({ name: { type: 'string' }, mounts: { type: 'array', items: closed({ sourceId: { type: 'string' } }) } });
  const agentRoute = (agentRefuses) => routeSchemaProblems({
    method: 'POST', url: '/x', config: { auth: 'agent', agentRefuses }, declaredSchema: { body, response: { 202: closed() } },
  });
  assert.deepEqual(agentRoute(['name', 'mounts/*/sourceId']), []);
  assert.deepEqual(agentRoute(['mounts/*/subPath', 'mounts/sourceId', 'other']), [
    'config.agentRefuses names keys the body schema does not list: mounts/*/subPath, mounts/sourceId, other',
  ]);
});
