/**
 * The wait between two looks at something that changes on another side (an
 * order's status, a zone's records): the other side's Retry-After when it
 * gives one, else a backoff that doubles from 1 s to 10 s; never past the
 * deadline, and cut by the signal.
 */
import { setTimeout as sleep } from 'node:timers/promises';

const FIRST_WAIT_MS = 1_000;
const LONGEST_BACKOFF_MS = 10_000;
/** A Retry-After further out than this is taken as this. */
const LONGEST_RETRY_AFTER_MS = 60_000;

/**
 * A Retry-After header's wait in ms: delay-seconds or an HTTP date (RFC 9110).
 * Null when absent or unreadable.
 */
export function retryAfterMs(header, now = Date.now()) {
  if (header == null || header === '') return null;
  const text = String(header).trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** How long to wait before try `attempt + 1` (0-based), given a Retry-After in ms or null. */
export function waitBeforeNextTry(attempt, retryAfter) {
  if (retryAfter != null) return Math.min(retryAfter, LONGEST_RETRY_AFTER_MS);
  return Math.min(FIRST_WAIT_MS * 2 ** attempt, LONGEST_BACKOFF_MS);
}

/** Wait before the next try, no later than `deadline` (epoch ms). */
export async function waitBetweenTries(attempt, retryAfter, deadline, signal) {
  const ms = Math.max(0, Math.min(waitBeforeNextTry(attempt, retryAfter), deadline - Date.now()));
  await sleep(ms, undefined, { signal });
}
