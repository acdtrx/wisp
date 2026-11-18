import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { installBrowser, installFetch, respondWithStream, settle } from '../testing/fakeBrowser.js';

let browser;
let net;
let createSSE;

beforeEach(async () => {
  browser = installBrowser();
  net = installFetch();
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  ({ createSSE } = await import('./sse.js'));
});

afterEach(() => {
  mock.timers.reset();
});

/** Open a createSSE stream and answer its first request. */
async function open(onMessage = () => {}, onError = () => {}) {
  const close = createSSE('/api/x', onMessage, onError);
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
  assert.deepEqual(messages, [{ topic: 'vms', data: [1] }, { b: 2 }]);
  close();
});

test('a stream the server ends reconnects after the backoff, without onError', async () => {
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

test('a broken connection calls onError, then reconnects', async () => {
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

test('closing aborts the open request', async () => {
  const { close, request } = await open();
  close();
  assert.equal(request.signal.aborted, true);
});

test('a 401 logs the session out, goes to the login page and does not reconnect', async () => {
  const errors = [];
  createSSE('/api/x', () => {}, (reason) => errors.push(reason));
  const request = await net.next('/api/x');
  request.respond(new Response(null, { status: 401 }));
  await settle();
  assert.match(browser.localStorage.getItem('wisp_logout'), /^expired:\d+$/);
  assert.equal(browser.window.location.href, '/login');
  mock.timers.tick(120_000);
  await settle();
  assert.equal(net.made('/api/x').length, 1);
  assert.deepEqual(errors, []);
});
