/**
 * A GitHub user's public SSH keys, for the import into Wisp's list
 * (docs/specs/SETTINGS.md, SSH keys).
 */
import { createAppError, wrapAppError } from './appErrors.js';
import { ssrfSafeFetch } from './outbound/index.js';

/** One small text reply: 10 s over its DNS lookup, the request and the body. */
const GITHUB_KEYS_TIMEOUT_MS = 10_000;
/** A user's keys are a few KB; past 256 KiB the answer is not a key list. */
const GITHUB_KEYS_MAX_BODY_BYTES = 256 * 1024;

/**
 * The public SSH keys GitHub lists for `username`, a GitHub login. Through the
 * SSRF guard: a redirect is followed only while each target resolves to a
 * public address.
 */
export async function fetchGithubKeys(username) {
  const signal = AbortSignal.timeout(GITHUB_KEYS_TIMEOUT_MS);
  const unavailable = (err) => wrapAppError('GITHUB_KEYS_UNAVAILABLE', 'Failed to fetch GitHub keys', err);
  let res;
  try {
    res = await ssrfSafeFetch(`https://github.com/${username}.keys`, { signal, maxBodyBytes: GITHUB_KEYS_MAX_BODY_BYTES });
  } catch (err) {
    throw unavailable(err);
  }
  // Only GitHub's own 404 says the user is unknown: a 429 or a 5xx says nothing about the user.
  if (res.status === 404) {
    throw createAppError('GITHUB_KEYS_NOT_FOUND', `No keys found for "${username}"`);
  }
  if (!res.ok) {
    throw createAppError('GITHUB_KEYS_UNAVAILABLE', `GitHub answered HTTP ${res.status}`, `HTTP ${res.status}`);
  }
  let text;
  try {
    text = await res.text();
  } catch (err) {
    throw unavailable(err);
  }
  return text.trim().split('\n').map((line) => line.trim()).filter(Boolean);
}
