import assert from 'node:assert/strict';
import test from 'node:test';

import { formatBytes, formatMemory, formatMemoryOf, formatRelativeTime } from './formatters.js';

test('a byte count is shown in powers of 1024: one decimal under 100, none from 100 up', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(0.4), '0 B');
  assert.equal(formatBytes(0.6), '1 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(14.9 * 1024 ** 3), '14.9 GB');
  assert.equal(formatBytes(85.7 * 1024 ** 2), '85.7 MB');
  assert.equal(formatBytes(937 * 1024 ** 3), '937 GB');
  assert.equal(formatBytes(6.1 * 1024 ** 3), '6.1 GB');
  assert.equal(formatBytes(20 * 1024 ** 3), '20.0 GB');
  assert.equal(formatBytes(3 * 1024 ** 5), '3072 TB');
});

test('the decimals are chosen after rounding, and 1024 rolls to the next unit', () => {
  assert.equal(formatBytes(99.96 * 1024 ** 2), '100 MB');
  assert.equal(formatBytes(99.94 * 1024 ** 2), '99.9 MB');
  assert.equal(formatBytes(1023.6), '1.0 KB');
  assert.equal(formatBytes(1023.7 * 1024 ** 2), '1.0 GB');
  assert.equal(formatBytes(1023.4 * 1024), '1023 KB');
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

test('a memory size in MiB is MB below 1 GB, then GB to one decimal, whole without ".0"', () => {
  assert.equal(formatMemory(512), '512 MB');
  assert.equal(formatMemory(1536), '1.5 GB');
  assert.equal(formatMemory(2048), '2 GB');
  assert.equal(formatMemory(2047), '2 GB');
  assert.equal(formatMemory(Math.round(14.93 * 1024)), '14.9 GB');
  assert.equal(formatMemory(null), '—');
});

test('a memory amount out of its limit writes the unit once when both share it', () => {
  assert.equal(formatMemoryOf(12, 256), '12 / 256 MB');
  assert.equal(formatMemoryOf(1536, 2048), '1.5 / 2 GB');
  assert.equal(formatMemoryOf(512, 2048), '512 MB / 2 GB');
  assert.equal(formatMemoryOf(0, 128), '0 / 128 MB');
  assert.equal(formatMemoryOf(null, 128), '— / 128 MB');
});
