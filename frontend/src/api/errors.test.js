import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ApiError, errorFromBody, errorText, isSessionLost } from './errors.js';

test('an ApiError carries status, code and detail; its message is the detail, else the code', () => {
  const err = new ApiError({ status: 404, code: 'VM_NOT_FOUND', detail: 'VM "a" not found' });
  assert.ok(err instanceof Error);
  assert.equal(err.status, 404);
  assert.equal(err.code, 'VM_NOT_FOUND');
  assert.equal(err.detail, 'VM "a" not found');
  assert.equal(err.message, 'VM "a" not found');

  const bare = new ApiError({ code: 'JOB_GONE' });
  assert.equal(bare.status, null);
  assert.equal(bare.detail, '');
  assert.equal(bare.message, 'JOB_GONE');
});

test('errorFromBody reads the server error body', () => {
  const err = errorFromBody({ error: 'VM_BUSY', detail: 'A backup is running' }, 409);
  assert.ok(err instanceof ApiError);
  assert.deepEqual({ status: err.status, code: err.code, detail: err.detail }, { status: 409, code: 'VM_BUSY', detail: 'A backup is running' });
});

test('errorFromBody keeps a body without detail as its code', () => {
  const err = errorFromBody({ error: 'ROUTE_NOT_FOUND' }, 404);
  assert.equal(err.code, 'ROUTE_NOT_FOUND');
  assert.equal(err.detail, '');
  assert.equal(err.message, 'ROUTE_NOT_FOUND');
});

test('errorFromBody turns anything that is not an error body into REQUEST_FAILED', () => {
  for (const body of [null, undefined, {}, { message: 'x' }, { error: 42 }, { error: '' }, 'text']) {
    const err = errorFromBody(body, 502);
    assert.equal(err.code, 'REQUEST_FAILED', JSON.stringify(body));
    assert.equal(err.status, 502);
    assert.equal(err.detail, 'Request failed (502)');
  }
});

test('isSessionLost is true for AUTH_REQUIRED and AUTH_INVALID only', () => {
  assert.equal(isSessionLost(new ApiError({ status: 401, code: 'AUTH_REQUIRED' })), true);
  assert.equal(isSessionLost(new ApiError({ status: 401, code: 'AUTH_INVALID' })), true);
  assert.equal(isSessionLost(new ApiError({ status: 401, code: 'LOGIN_FAILED' })), false);
  assert.equal(isSessionLost(new ApiError({ status: 429, code: 'RATE_LIMITED' })), false);
  assert.equal(isSessionLost(new Error('Session expired')), false);
  assert.equal(isSessionLost(null), false);
  assert.equal(isSessionLost(undefined), false);
});

test('errorText shows an ApiError by its detail, else its code', () => {
  assert.equal(errorText(new ApiError({ status: 500, code: 'INTERNAL_ERROR', detail: 'boom' })), 'boom');
  assert.equal(errorText(new ApiError({ code: 'JOB_GONE' })), 'JOB_GONE');
});

test('errorText shows a plain Error by its message', () => {
  assert.equal(errorText(new Error('Failed to fetch')), 'Failed to fetch');
  assert.equal(errorText(new TypeError('Load failed')), 'Load failed');
});

test('errorText shows a stream frame or job event by its detail, else its code', () => {
  assert.equal(errorText({ error: 'STATS_UNAVAILABLE', detail: 'No stats yet' }), 'No stats yet');
  assert.equal(errorText({ step: 'error', error: 'BACKUP_FAILED', detail: 'disk full' }), 'disk full');
  assert.equal(errorText({ step: 'error', error: 'BACKUP_FAILED' }), 'BACKUP_FAILED');
});

test('errorText falls back to "Unknown error" when nothing says what failed', () => {
  assert.equal(errorText(null), 'Unknown error');
  assert.equal(errorText(undefined), 'Unknown error');
  assert.equal(errorText({}), 'Unknown error');
  assert.equal(errorText(new Error('')), 'Unknown error');
});
