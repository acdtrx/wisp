import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAppError } from '../appErrors.js';
import { toolError } from './mcpServer.js';

test("a tool error carries the error body, its cause's path redacted, as text and structured", () => {
  const err = createAppError('CONTAINERD_ERROR', 'Failed to read run log for "x"', "EACCES: permission denied, open '/var/lib/wisp/x.log'");
  const { id, result } = toolError(3, err);
  assert.equal(id, 3);
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    error: 'CONTAINERD_ERROR',
    detail: "Failed to read run log for \"x\": EACCES: permission denied, open '<path>'",
  });
  assert.equal(result.content[0].type, 'text');
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.doesNotMatch(result.content[0].text, /\/var\/lib/);
});
