/*
 * The GitHub keys lookup's answers, with the SSRF-guarded fetch mocked
 * (node --test --experimental-test-module-mocks): a test cannot reach
 * github.com, and the guard refuses a local stub. The lookup itself, through
 * the real guard, is verified on a host (CODING-RULES §14).
 */
import { beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';

import { createAppError } from './appErrors.js';

const requests = [];
let answer;

mock.module(new URL('./downloads/index.js', import.meta.url).href, {
  exports: {
    ssrfSafeFetch: async (url, init) => {
      requests.push({ url, init });
      return answer();
    },
  },
});
const { fetchGithubKeys } = await import('./githubKeys.js');

beforeEach(() => {
  requests.length = 0;
});

test('the keys are the lines of the .keys answer, under a deadline and a size bound', async () => {
  answer = () => new Response('ssh-ed25519 AAAA one\nssh-rsa BBBB two\n\n');
  assert.deepEqual(await fetchGithubKeys('octocat'), ['ssh-ed25519 AAAA one', 'ssh-rsa BBBB two']);
  assert.equal(requests[0].url, 'https://github.com/octocat.keys');
  assert.ok(requests[0].init.signal instanceof AbortSignal);
  assert.ok(requests[0].init.maxBodyBytes > 0);
});

test("GitHub's 404 is GITHUB_KEYS_NOT_FOUND", async () => {
  answer = () => new Response('Not Found', { status: 404 });
  await assert.rejects(fetchGithubKeys('nobody'), { code: 'GITHUB_KEYS_NOT_FOUND' });
});

test('any other answer that is not 2xx is GITHUB_KEYS_UNAVAILABLE, the status in its cause', async () => {
  for (const status of [429, 500, 503, 403, 302]) {
    answer = () => new Response('', { status });
    await assert.rejects(fetchGithubKeys('octocat'), (err) => err.code === 'GITHUB_KEYS_UNAVAILABLE'
      && err.raw === `HTTP ${status}`, String(status));
  }
});

test('a refused or failed request is GITHUB_KEYS_UNAVAILABLE, its cause kept', async () => {
  answer = () => { throw createAppError('SSRF_BLOCKED', 'URL must not resolve to a private or loopback address'); };
  await assert.rejects(fetchGithubKeys('octocat'), (err) => err.code === 'GITHUB_KEYS_UNAVAILABLE'
    && /private or loopback/.test(err.message));

  answer = () => { throw new TypeError('fetch failed'); };
  await assert.rejects(fetchGithubKeys('octocat'), (err) => err.code === 'GITHUB_KEYS_UNAVAILABLE'
    && err.raw === 'fetch failed');
});
