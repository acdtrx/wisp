/**
 * Per-IP rate limiting for authentication attempts. Failed password logins and
 * invalid bearer tokens feed the same window so an attacker can't double their
 * budget by alternating between the two surfaces. In-memory by design — a
 * restart clearing the counters is acceptable for a single-user LAN app.
 */

const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_ATTEMPTS = 5;
const ATTEMPTS_MAX_ENTRIES = 10_000;
const SWEEP_INTERVAL_MS = 60 * 1000;

export const AUTH_RATE_WINDOW_SECONDS = Math.ceil(RATE_WINDOW_MS / 1000);

const attempts = new Map();

// Periodic sweep so the map can't grow unbounded (one entry per failing IP).
// `unref()` so the sweep timer doesn't hold the process open during shutdown.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of attempts) {
    if (now > entry.resetAt) attempts.delete(ip);
  }
}, SWEEP_INTERVAL_MS).unref();

export function isAuthRateLimited(ip) {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now > entry.resetAt) return false;
  return entry.count >= RATE_MAX_ATTEMPTS;
}

export function recordFailedAuthAttempt(ip) {
  const now = Date.now();
  let entry = attempts.get(ip);
  if (!entry || now > entry.resetAt) {
    // Hard cap on map size in case the sweep falls behind a flood of distinct
    // IPs. Returning early means we just stop counting failures for new IPs
    // until the window rolls — acceptable trade-off vs. unbounded memory.
    if (attempts.size >= ATTEMPTS_MAX_ENTRIES) return;
    entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
    attempts.set(ip, entry);
  }
  entry.count += 1;
}
