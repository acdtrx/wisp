import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAppError } from './appErrors.js';
import { writeSSEError } from './sse.js';

/** A stand-in for the response stream: records what was written. */
function fakeResponse() {
  return {
    chunks: [],
    write(chunk) { this.chunks.push(chunk); },
  };
}

test('an error frame is the error body as one data: line, its cause redacted', () => {
  const raw = fakeResponse();
  writeSSEError(raw, createAppError('CONTAINERD_ERROR', 'Failed to read run log for "x"', "EACCES: permission denied, open '/var/lib/wisp/x.log'"));
  assert.deepEqual(raw.chunks, [
    'data: {"error":"CONTAINERD_ERROR","detail":"Failed to read run log for \\"x\\": EACCES: permission denied, open \'<path>\'"}\n\n',
  ]);
});

test('an error with no code is framed as INTERNAL_ERROR', () => {
  const raw = fakeResponse();
  writeSSEError(raw, new Error('cannot read /proc/x'));
  assert.deepEqual(raw.chunks, ['data: {"error":"INTERNAL_ERROR","detail":"cannot read <path>"}\n\n']);
});
