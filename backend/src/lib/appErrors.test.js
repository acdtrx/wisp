import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Readable } from 'node:stream';

import Fastify from 'fastify';

import { createAppError, errorBody, errorStatus, handleRequestError, isExpectedAppError, redactDetail } from './appErrors.js';
import { ERROR_STATUS } from './errorCodes.js';

test('an app error becomes { error: code, detail: message }', () => {
  assert.deepEqual(errorBody(createAppError('VM_NOT_FOUND', 'VM "web" not found')), {
    error: 'VM_NOT_FOUND',
    detail: 'VM "web" not found',
  });
});

test('the raw cause follows the message, unless the message already says it', () => {
  assert.equal(errorBody(createAppError('RESIZE_FAILED', 'Failed to resize disk', 'qemu-img: no space')).detail,
    'Failed to resize disk: qemu-img: no space');
  assert.equal(errorBody(createAppError('RESIZE_FAILED', 'Failed: boom', 'boom')).detail, 'Failed: boom');
});

test('an error without a code from the table is INTERNAL_ERROR, its message kept', () => {
  const errno = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
  assert.deepEqual(errorBody(errno), { error: 'INTERNAL_ERROR', detail: 'EACCES: permission denied' });
  assert.deepEqual(errorBody(new TypeError('x is not a function')), { error: 'INTERNAL_ERROR', detail: 'x is not a function' });
  assert.deepEqual(errorBody('a string'), { error: 'INTERNAL_ERROR', detail: 'a string' });
  assert.equal(errorStatus('INTERNAL_ERROR'), 500);
});

test('paths and UUIDs are redacted where they start a token, and the detail is capped', () => {
  assert.equal(redactDetail('cannot open /var/lib/wisp/vms/a/disk0.qcow2: busy'), 'cannot open <path>: busy');
  assert.equal(redactDetail('mount "/mnt/wisp/smb/x" failed'), 'mount "<path>" failed');
  assert.equal(redactDetail('domain 0f8fad5b-d9cb-469f-a165-70867728950e gone'), 'domain <uuid> gone');
  assert.equal(redactDetail('pull docker.io/library/nginx:1.27 failed'), 'pull docker.io/library/nginx:1.27 failed');
  assert.equal(redactDetail('fetch https://github.com/u.keys failed'), 'fetch https://github.com/u.keys failed');
  assert.equal(redactDetail('body/vlanId must be number'), 'body/vlanId must be number');
  assert.equal(redactDetail('No route for GET /api/nope'), 'No route for GET /api/nope');
  assert.equal(redactDetail('send it to /mcp'), 'send it to /mcp');
  assert.equal(redactDetail('see /apix/y'), 'see <path>');
  assert.equal(redactDetail('x'.repeat(600)).length, 501);
});

test('redaction applies to the message as well as the raw cause', () => {
  const body = errorBody(createAppError('LIBVIRT_ERROR', 'Failed to define /etc/libvirt/qemu/a.xml', 'see /var/log/x'));
  assert.equal(body.detail, 'Failed to define <path>: see <path>');
});

test('a 4xx code is expected, a 5xx code and an unknown one are not', () => {
  assert.equal(isExpectedAppError(createAppError('VM_BUSY', 'busy')), true);
  assert.equal(isExpectedAppError(createAppError('LIBVIRT_ERROR', 'x')), false);
  assert.equal(isExpectedAppError(new Error('x')), false);
});

test('every status in the table is an HTTP error status', () => {
  for (const [code, status] of Object.entries(ERROR_STATUS)) {
    assert.ok(Number.isInteger(status) && status >= 400 && status < 600, code);
  }
});

/** A bare app with the one handler and routes that throw. */
async function appWithThrowingRoutes() {
  const app = Fastify({ logger: false });
  app.setErrorHandler(handleRequestError);
  app.get('/missing', async () => {
    throw createAppError('VM_NOT_FOUND', 'VM "web" not found');
  });
  app.get('/fault', async () => {
    throw new Error('cannot read /var/lib/wisp/secret');
  });
  app.get('/download', async (request, reply) => {
    reply.header('Content-Type', 'text/plain; charset=utf-8').header('Content-Disposition', 'attachment; filename="a.log"');
    const stream = new Readable({ read() { this.destroy(createAppError('CONTAINER_RUN_NOT_FOUND', 'No such run')); } });
    return reply.send(stream);
  });
  app.post('/typed', {
    schema: {
      body: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'], additionalProperties: false },
    },
    handler: async () => ({ ok: true }),
  });
  await app.ready();
  return app;
}

test('a route that throws an app error answers its status and the body', async () => {
  const app = await appWithThrowingRoutes();
  const res = await app.inject({ method: 'GET', url: '/missing' });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.json(), { error: 'VM_NOT_FOUND', detail: 'VM "web" not found' });
  await app.close();
});

test('an unexpected error answers 500 INTERNAL_ERROR with a redacted detail', async () => {
  const app = await appWithThrowingRoutes();
  const res = await app.inject({ method: 'GET', url: '/fault' });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.json(), { error: 'INTERNAL_ERROR', detail: 'cannot read <path>' });
  await app.close();
});

test('a route that set download headers and then failed answers the error as JSON', async () => {
  const app = await appWithThrowingRoutes();
  const res = await app.inject({ method: 'GET', url: '/download' });
  assert.equal(res.statusCode, 404);
  assert.match(res.headers['content-type'], /^application\/json/);
  assert.equal(res.headers['content-disposition'], undefined);
  assert.deepEqual(res.json(), { error: 'CONTAINER_RUN_NOT_FOUND', detail: 'No such run' });
  await app.close();
});

test('a schema refusal answers 400 VALIDATION_FAILED naming the field', async () => {
  const app = await appWithThrowingRoutes();
  const missing = await app.inject({ method: 'POST', url: '/typed', payload: {} });
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.json().error, 'VALIDATION_FAILED');
  assert.match(missing.json().detail, /^body must have required property 'n'/);
  const malformed = await app.inject({
    method: 'POST', url: '/typed', payload: '{"n":', headers: { 'content-type': 'application/json' },
  });
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.json().error, 'BAD_REQUEST');
  await app.close();
});
