import assert from 'node:assert/strict';
import test from 'node:test';

import { formatBytes, formatRelativeTime } from './formatters.js';

test('a byte count is shown in powers of 1024, one decimal under 10', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(20 * 1024 ** 3), '20 GB');
  assert.equal(formatBytes(9.96 * 1024 ** 2), '10.0 MB');
  assert.equal(formatBytes(3 * 1024 ** 5), '3072 TB');
});

test('a missing or invalid byte count is a dash', () => {
  for (const value of [null, undefined, Number.NaN, -1, '12']) assert.equal(formatBytes(value), '—');
});

test('a time is shown as how long ago it was, then as its date after 30 days', () => {
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  assert.equal(formatRelativeTime(ago(10_000)), 'just now');
  assert.equal(formatRelativeTime(ago(5 * 60_000)), '5m ago');
  assert.equal(formatRelativeTime(ago(3 * 3_600_000)), '3h ago');
  assert.equal(formatRelativeTime(ago(2 * 86_400_000)), '2d ago');
  const old = ago(40 * 86_400_000);
  assert.equal(formatRelativeTime(old), new Date(old).toLocaleDateString());
  assert.equal(formatRelativeTime(null), '—');
  assert.equal(formatRelativeTime('not a time'), '—');
});
