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
