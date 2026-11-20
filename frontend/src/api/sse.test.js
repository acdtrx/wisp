import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { installBrowser, installFetch, jsonResponse, respondWithStream, settle } from '../testing/fakeBrowser.js';
import { TOPIC } from '../../../shared/wireNames.js';

let browser;
let net;
let openStream;
let isTerminalJobEvent;
let ApiError;

beforeEach(async () => {
  browser = installBrowser();
  net = installFetch();
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  ({ openStream } = await import('./sse.js'));
  ({ isTerminalJobEvent } = await import('./jobs.js'));
  ({ ApiError } = await import('./errors.js'));
});

afterEach(() => {
  mock.timers.reset();
});

/** Open a stream and answer its first request. */
async function open(onFrame = () => {}, onDown = () => {}) {
  const close = openStream('/api/x', onFrame, { onDown });
  const request = await net.next('/api/x');
  const stream = respondWithStream(request);
  await settle();
  return { close, request, stream };
}

test('a frame split across chunks is delivered whole, once', async () => {
  const messages = [];
  const { close, stream } = await open((data) => messages.push(data));
  stream.send('data: {"topic":"vms",');
  await settle();
  assert.deepEqual(messages, []);
  stream.send('"data":[1]}\n');
  stream.send('\ndata: {"b":2}\n\n');
  await settle();
  assert.deepEqual(messages, [{ topic: TOPIC.VMS, data: [1] }, { b: 2 }]);
  close();
});

test('a stream the server ends reconnects after the backoff, without onDown', async () => {
  const errors = [];
  const { close, stream } = await open(() => {}, (reason) => errors.push(reason));
  stream.end();
  await settle();
  assert.equal(net.made('/api/x').length, 1);
  mock.timers.tick(1100); // first retry: 1 s, jitter within ±5 %
  await settle();
  assert.equal(net.made('/api/x').length, 2);
  assert.deepEqual(errors, []);
  close();
});

test('a broken connection calls onDown, then reconnects', async () => {
  const errors = [];
  const { close, stream } = await open(() => {}, (reason) => errors.push(reason));
  stream.drop();
  await settle();
  assert.deepEqual(errors, [undefined]);
  mock.timers.tick(1100);
  await settle();
  assert.equal(net.made('/api/x').length, 2);
  close();
});

test('closing stops the reconnect', async () => {
  const { close, stream } = await open();
  stream.end();
  await settle();
  close();
  mock.timers.tick(60_000);
  await settle();
  assert.equal(net.made('/api/x').length, 1);
});

test('closing an open stream aborts its request and stops it, with no onDown', async () => {
  const errors = [];
  const { close, request } = await open(() => {}, (reason) => errors.push(reason));
  close();
  assert.equal(request.signal.aborted, true);
  await settle();
  mock.timers.tick(60_000);
  await settle();
  assert.equal(net.made('/api/x').length, 1);
  assert.deepEqual(errors, []);
});

test('a lost session logs out, goes to the login page and does not reconnect', async () => {
  const errors = [];
  openStream('/api/x', () => {}, { onDown: (reason) => errors.push(reason) });
  const request = await net.next('/api/x');
  request.respond(jsonResponse({ error: 'AUTH_INVALID', detail: 'Session expired' }, 401));
  await settle();
  assert.match(browser.localStorage.getItem('wisp_logout'), /^expired:\d+$/);
  assert.equal(browser.window.location.href, '/login');
  mock.timers.tick(120_000);
  await settle();
  assert.equal(net.made('/api/x').length, 1);
  assert.deepEqual(errors, []);
});

test('a 4xx stops the stream for good, its ApiError to onDown: a 404 and a 400 alike', async () => {
  for (const [status, body] of [
    [404, { error: 'CONTAINER_RUN_NOT_FOUND', detail: 'No such run' }],
    [400, { error: 'VALIDATION_FAILED', detail: 'querystring/runId must match pattern' }],
  ]) {
    const errors = [];
    const close = openStream(`/api/x${status}`, () => {}, { onDown: (err) => errors.push(err) });
    const request = await net.next(`/api/x${status}`);
    request.respond(jsonResponse(body, status));
    await settle();
    assert.equal(errors.length, 1, String(status));
    assert.ok(errors[0] instanceof ApiError, String(status));
    assert.deepEqual({ status: errors[0].status, code: errors[0].code, detail: errors[0].detail }, { status, code: body.error, detail: body.detail });
    mock.timers.tick(120_000);
    await settle();
    assert.equal(net.made(`/api/x${status}`).length, 1, String(status));
    close();
  }
});

test('a 5xx is retried like a lost connection: onDown with no error, then a reconnect', async () => {
  const errors = [];
  const close = openStream('/api/x', () => {}, { onDown: (err) => errors.push(err) });
  const request = await net.next('/api/x');
  request.respond(jsonResponse({ error: 'LIBVIRT_ERROR', detail: 'Failed' }, 500));
  await settle();
  assert.deepEqual(errors, [undefined]);
  mock.timers.tick(1100);
  await settle();
  assert.equal(net.made('/api/x').length, 2);
  close();
});

test('a 4xx that is not Wisp\'s answer is retried like a lost connection, never a login or an end', async () => {
  for (const [i, [status, response]] of [
    [401, new Response('<html>401 Authorization Required</html>', { status: 401, headers: { 'content-type': 'text/html' } })],
    [403, jsonResponse({ message: 'Forbidden' }, 403)],
    [403, jsonResponse({ error: 'Forbidden' }, 403)],
    [404, new Response('', { status: 404 })],
  ].entries()) {
    const errors = [];
    const url = `/api/proxy${i}-${status}`;
    const close = openStream(url, () => {}, { onDown: (err) => errors.push(err) });
    const request = await net.next(url);
    request.respond(response);
    await settle();
    assert.deepEqual(errors, [undefined], url);
    assert.equal(browser.window.location.href, '', url);
    assert.equal(browser.localStorage.getItem('wisp_logout'), null, url);
    mock.timers.tick(1100);
    await settle();
    assert.equal(net.made(url).length, 2, url);
    close();
  }
});

/* ── A stream that ends at a terminal frame (job progress): the same rule ── */


test('a frame endsAt matches is delivered and ends the stream: no reconnect', async () => {
  const frames = [];
  const downs = [];
  openStream('/api/jobs/j0/progress', (f) => frames.push(f), { onDown: (e) => downs.push(e), endsAt: isTerminalJobEvent });
  const stream = respondWithStream(await net.next('/api/jobs/j0/progress'));
  await settle();
  stream.send('data: {"step":"copy","percent":50}\n\ndata: {"step":"done","result":1}\n\ndata: {"step":"late"}\n\n');
  await settle();
  assert.deepEqual(frames, [{ step: 'copy', percent: 50 }, { step: 'done', result: 1 }]);
  mock.timers.tick(120_000);
  await settle();
  assert.equal(net.made('/api/jobs/j0/progress').length, 1);
  assert.deepEqual(downs, []);
});

test('a job stream refused with a 4xx ends, its ApiError to onDown; no reconnect', async () => {
  const refused = [];
  openStream('/api/jobs/j1/progress', () => {}, { onDown: (err) => err && refused.push(err), endsAt: isTerminalJobEvent });
  const request = await net.next('/api/jobs/j1/progress');
  request.respond(jsonResponse({ error: 'VALIDATION_FAILED', detail: 'params/jobId must match' }, 400));
  await settle();
  assert.equal(refused.length, 1);
  assert.ok(refused[0] instanceof ApiError);
  assert.equal(refused[0].code, 'VALIDATION_FAILED');
  assert.equal(refused[0].status, 400);
  mock.timers.tick(120_000);
  await settle();
  assert.equal(net.made('/api/jobs/j1/progress').length, 1);
});

test('a job stream answered a 5xx reconnects, and is not refused', async () => {
  const refused = [];
  const close = openStream('/api/jobs/j2/progress', () => {}, { onDown: (err) => err && refused.push(err), endsAt: isTerminalJobEvent });
  const request = await net.next('/api/jobs/j2/progress');
  request.respond(jsonResponse({ error: 'INTERNAL_ERROR', detail: 'boom' }, 500));
  await settle();
  mock.timers.tick(1100);
  await settle();
  assert.equal(net.made('/api/jobs/j2/progress').length, 2);
  assert.deepEqual(refused, []);
  close();
});

test('a job stream answered a proxy\'s 403 page reconnects, and is not refused', async () => {
  const refused = [];
  const close = openStream('/api/jobs/j3/progress', () => {}, { onDown: (err) => err && refused.push(err), endsAt: isTerminalJobEvent });
  const request = await net.next('/api/jobs/j3/progress');
  request.respond(new Response('<html>403</html>', { status: 403, headers: { 'content-type': 'text/html' } }));
  await settle();
  mock.timers.tick(1100);
  await settle();
  assert.equal(net.made('/api/jobs/j3/progress').length, 2);
  assert.deepEqual(refused, []);
  close();
});
