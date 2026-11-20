import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { installBrowser, settle } from '../testing/fakeBrowser.js';
import { installXhr } from '../testing/fakeXhr.js';

let browser;
let xhr;
let postMultipartFile;
let LOGIN_NOTICE_KEY;
let API_TIMEOUT_MS;
let ApiError;

beforeEach(async () => {
  browser = installBrowser();
  xhr = installXhr();
  mock.timers.enable({ apis: ['setTimeout'] });
  ({ postMultipartFile } = await import('./upload.js'));
  ({ API_TIMEOUT_MS, LOGIN_NOTICE_KEY } = await import('./client.js'));
  ({ ApiError } = await import('./errors.js'));
});

afterEach(() => {
  mock.timers.reset();
});

/** Start an upload; returns its request and a promise of what it rejected with. */
function upload(options) {
  const call = postMultipartFile('/api/library/upload', new Blob(['data']), options).then(
    () => assert.fail('postMultipartFile resolved'),
    (err) => err,
  );
  return { request: xhr.last(), failure: call };
}

test('an error answer becomes an ApiError from the body', async () => {
  const { request, failure } = upload();
  request.bodySent();
  request.respond(409, { error: 'LIBRARY_FILE_EXISTS', detail: 'A file named "a.iso" exists' });
  const err = await failure;
  assert.ok(err instanceof ApiError);
  assert.deepEqual(
    { status: err.status, code: err.code, detail: err.detail },
    { status: 409, code: 'LIBRARY_FILE_EXISTS', detail: 'A file named "a.iso" exists' },
  );
  assert.equal(browser.localStorage.getItem('wisp_logout'), null);
  assert.equal(browser.window.location.href, '');
});

test('a lost session logs out, goes to the login page and rejects with the ApiError', async () => {
  const { request, failure } = upload();
  request.bodySent();
  request.respond(401, { error: 'AUTH_INVALID', detail: 'Sign in again' });
  const err = await failure;
  assert.ok(err instanceof ApiError);
  assert.equal(err.code, 'AUTH_INVALID');
  assert.equal(err.status, 401);
  assert.match(browser.localStorage.getItem('wisp_logout'), /^expired:\d+$/);
  assert.equal(browser.window.location.href, '/login');
  assert.equal(browser.sessionStorage.getItem(LOGIN_NOTICE_KEY), 'Sign in again');
});

test('a request that never reaches the server rejects with UPLOAD_FAILED', async () => {
  const { request, failure } = upload();
  request.networkError();
  const err = await failure;
  assert.ok(err instanceof ApiError);
  assert.equal(err.code, 'UPLOAD_FAILED');
  assert.equal(err.status, null);
});

test('60 s without upload progress rejects with UPLOAD_STALLED; progress re-arms the watch', async () => {
  const progress = [];
  const { request, failure } = upload({ onProgress: (p) => progress.push(p) });
  let settled = false;
  failure.then(() => { settled = true; });
  mock.timers.tick(30_000);
  request.progress(50, 100);
  mock.timers.tick(59_000);
  await settle();
  assert.equal(settled, false);
  mock.timers.tick(1_000);
  const err = await failure;
  assert.ok(err instanceof ApiError);
  assert.equal(err.code, 'UPLOAD_STALLED');
  assert.deepEqual(progress, [50]);
});

test('no reply within the deadline after the body is sent rejects with TIMEOUT', async () => {
  const { request, failure } = upload();
  request.bodySent();
  mock.timers.tick(API_TIMEOUT_MS);
  const err = await failure;
  assert.ok(err instanceof ApiError);
  assert.equal(err.code, 'TIMEOUT');
});

test('an upload the browser aborts rejects with UPLOAD_CANCELLED', async () => {
  const { request, failure } = upload();
  request.abort();
  const err = await failure;
  assert.ok(err instanceof ApiError);
  assert.equal(err.code, 'UPLOAD_CANCELLED');
});
