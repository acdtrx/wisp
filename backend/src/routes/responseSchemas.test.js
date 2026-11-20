/*
 * Every answer a route's response schema serializes keeps every field and
 * every null (docs/TECH-STACK.md: response schemas are authoritative). Fastify
 * serializes a 2xx through fast-json-stringify, which drops a key its schema
 * does not list and turns a `null` under a non-nullable type into `""`, `0`,
 * `false` or `{}`, silently. Each fixture is an answer of a route — captured on
 * a host and scrubbed, or written by hand for a state the capture did not
 * catch — put through that route's own response schema by Fastify, on a test
 * route of a Fastify instance of its own, and compared with what went in.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Fastify from 'fastify';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'responses');

/** Keys a handler's value carries for the server alone, which the answer leaves out on purpose. */
const INTERNAL_FIELDS = new Set(['_hostdevs']);

const dir = mkdtempSync(path.join(tmpdir(), 'wisp-response-test-'));
writeFileSync(path.join(dir, 'wisp-config.json'), '{}\n');
// config.js reads the path when it loads: set it before the app is imported.
process.env.WISP_CONFIG_PATH = path.join(dir, 'wisp-config.json');

const fixtures = readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort()
  .map((file) => ({ file, ...JSON.parse(readFileSync(path.join(FIXTURES, file), 'utf8')) }));

/** `METHOD url` → the route's declared schema, from the real app. */
let routeSchemas;
/** A Fastify instance with one test route per fixture, each answering what it is sent through its route's schema. */
let serializer;

before(async () => {
  const { buildApp } = await import('../app.js');
  const log = Fastify({ logger: { level: 'silent' } }).log;
  const { app, routeAccess } = await buildApp(log);
  routeSchemas = new Map(routeAccess.list().map((r) => [`${r.method} ${r.url}`, r.declaredSchema]));
  await app.close();
  serializer = Fastify({ logger: { level: 'silent' } });
  for (const { file, route, status } of fixtures) {
    const schema = routeSchemas.get(route)?.response?.[status];
    if (!schema) continue;
    serializer.post(`/${file}`, {
      schema: { response: { [status]: schema } },
      handler: async (request, reply) => reply.code(status).send(request.body.body),
    });
  }
  await serializer.ready();
});

after(async () => {
  await serializer?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Where `out` differs from `input`: a dropped key, an added one, a changed value, by path. */
function differences(input, out, at = '') {
  if (input === null || typeof input !== 'object' || out === null || typeof out !== 'object') {
    return Object.is(input, out) ? [] : [`${at || '/'}: ${JSON.stringify(input)} became ${JSON.stringify(out)}`];
  }
  if (Array.isArray(input) !== Array.isArray(out)) return [`${at || '/'}: ${JSON.stringify(input)} became ${JSON.stringify(out)}`];
  const found = [];
  if (Array.isArray(input)) {
    if (input.length !== out.length) found.push(`${at || '/'}: ${input.length} items became ${out.length}`);
    input.forEach((item, i) => found.push(...differences(item, out[i], `${at}/${i}`)));
    return found;
  }
  for (const key of Object.keys(input)) {
    if (INTERNAL_FIELDS.has(key)) {
      if (key in out) found.push(`${at}/${key}: internal, sent`);
      continue;
    }
    if (!(key in out)) found.push(`${at}/${key}: dropped`);
    else found.push(...differences(input[key], out[key], `${at}/${key}`));
  }
  for (const key of Object.keys(out)) if (!(key in input)) found.push(`${at}/${key}: added`);
  return found;
}

/** The fixture's body as its route's response schema serializes it, parsed back. */
async function serialize({ file, status, body }) {
  const res = await serializer.inject({ method: 'POST', url: `/${file}`, payload: { body } });
  assert.equal(res.statusCode, status, res.body);
  return res.json();
}

test('every fixture names a route of the app that has its response schema', () => {
  for (const { file, route, status } of fixtures) {
    assert.ok(routeSchemas.has(route), `${file}: no route ${route}`);
    assert.ok(routeSchemas.get(route).response?.[status], `${file}: ${route} has no ${status} schema`);
  }
});

for (const fixture of fixtures) {
  test(`${fixture.route} keeps every field and value: ${fixture.file}`, async () => {
    assert.deepEqual(differences(fixture.body, await serialize(fixture)), []);
  });
}
