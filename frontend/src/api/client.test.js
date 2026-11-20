import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installBrowser, installFetch, jsonResponse, settle } from '../testing/fakeBrowser.js';

let browser;
let net;
let api;
let ApiError;

beforeEach(async () => {
  browser = installBrowser();
  net = installFetch();
  ({ api } = await import('./client.js'));
  ({ ApiError } = await import('./errors.js'));
});

/** Call api(path), answer its request with `response`, and return what it rejected with. */
async function failure(path, response, options) {
  const call = api(path, options).then(
    () => assert.fail('api() resolved'),
    (err) => err,
  );
  (await net.nextExact(path)).respond(response);
  await settle();
  return call;
}

test('an error answer becomes an ApiError with its status, code and detail', async () => {
  const err = await failure('/api/vms/a', jsonResponse({ error: 'VM_NOT_FOUND', detail: 'VM "a" not found' }, 404));
  assert.ok(err instanceof ApiError);
  assert.deepEqual(
    { status: err.status, code: err.code, detail: err.detail, message: err.message },
    { status: 404, code: 'VM_NOT_FOUND', detail: 'VM "a" not found', message: 'VM "a" not found' },
  );
  assert.equal(browser.localStorage.getItem('wisp_logout'), null);
  assert.equal(browser.window.location.href, '');
});

test('an answer that is not an error body fails with REQUEST_FAILED', async () => {
  const err = await failure('/api/host', new Response('<html>Bad gateway</html>', { status: 502 }));
  assert.ok(err instanceof ApiError);
  assert.deepEqual({ status: err.status, code: err.code, detail: err.detail }, { status: 502, code: 'REQUEST_FAILED', detail: 'Request failed (502)' });
});

for (const code of ['AUTH_REQUIRED', 'AUTH_INVALID']) {
  test(`${code} logs the session out, goes to the login page and throws the ApiError`, async () => {
    const err = await failure('/api/host', jsonResponse({ error: code, detail: 'Sign in again' }, 401));
    assert.ok(err instanceof ApiError);
    assert.equal(err.code, code);
    assert.equal(err.status, 401);
    assert.match(browser.localStorage.getItem('wisp_logout'), /^expired:\d+$/);
    assert.equal(browser.window.location.href, '/login');
  });
}

test('a 401 that is not a lost session stays on the page', async () => {
  const err = await failure('/api/auth/login', jsonResponse({ error: 'LOGIN_FAILED', detail: 'Wrong password' }, 401));
  assert.equal(err.code, 'LOGIN_FAILED');
  assert.equal(browser.localStorage.getItem('wisp_logout'), null);
  assert.equal(browser.window.location.href, '');
});

test('a call past its deadline fails with TIMEOUT and no status', async () => {
  const call = api('/api/slow', { timeoutMs: 20 });
  await net.nextExact('/api/slow'); // never answered
  const err = await call.then(() => assert.fail('api() resolved'), (e) => e);
  assert.ok(err instanceof ApiError);
  assert.equal(err.code, 'TIMEOUT');
  assert.equal(err.status, null);
  assert.match(err.detail, /did not answer/);
});

test('a success answer is returned as its JSON', async () => {
  const call = api('/api/host');
  (await net.nextExact('/api/host')).respond(jsonResponse({ hostname: 'h' }));
  assert.deepEqual(await call, { hostname: 'h' });
});
