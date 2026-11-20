/*
 * The update check's failures, with the SSRF-guarded fetch mocked
 * (node --test --experimental-test-module-mocks): a test cannot reach
 * api.github.com, and the guard refuses a local stub. The mock fails as the
 * real one does past `maxBodyBytes`: DOWNLOAD_FAILED, thrown when the declared
 * length is over it, or from the body as it is read.
 */
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';

import { createAppError } from './appErrors.js';

let answer;

mock.module(new URL('./downloads/index.js', import.meta.url).href, {
  namedExports: {
    ssrfSafeFetch: async (_url, init) => answer(init),
    writeResponseToFile: async () => 0,
  },
});
mock.module(new URL('./settings.js', import.meta.url).href, {
  namedExports: { getSettings: async () => ({ updateChannel: 'stable' }) },
});
mock.module(new URL('./storage/index.js', import.meta.url).href, {
  namedExports: { createStallWatchdog() {}, stallMinutes() {}, killProcessGroup() {} },
});

const { checkForUpdate, getCachedStatus } = await import('./wispUpdate.js');

const tooLarge = (maxBodyBytes) => createAppError('DOWNLOAD_FAILED', `The answer is larger than ${maxBodyBytes} bytes`);

function overBound(err) {
  return err.code === 'UPDATE_CHECK_UNAVAILABLE'
    && /answered more than its \d+-byte bound/.test(err.message)
    && /larger than \d+ bytes/.test(err.raw);
}

test('an answer whose declared length is over the bound fails the check as too large', async () => {
  answer = ({ maxBodyBytes }) => { throw tooLarge(maxBodyBytes); };
  await assert.rejects(checkForUpdate(), overBound);
  assert.equal(getCachedStatus().lastError, 'GitHub API answer too large');
});

test('an answer that passes the bound as it is read fails the check as too large', async () => {
  answer = ({ maxBodyBytes }) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"tag_name":'));
      controller.error(tooLarge(maxBodyBytes));
    },
  }));
  await assert.rejects(checkForUpdate(), overBound);
  assert.equal(getCachedStatus().lastError, 'GitHub API answer too large');
});

test('an answer that is not JSON is still malformed', async () => {
  answer = () => new Response('<html>');
  await assert.rejects(checkForUpdate(), { code: 'UPDATE_CHECK_UNAVAILABLE', message: 'Malformed GitHub API response' });
  assert.equal(getCachedStatus().lastError, 'Malformed GitHub API response');
});
