import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAppError } from '../appErrors.js';
import { createJobStore } from './jobStore.js';

/** A stand-in for a response stream: records what was written, and whether it ended. */
function fakeStream() {
  return {
    chunks: [],
    ended: false,
    write(chunk) { this.chunks.push(chunk); },
    end() { this.ended = true; },
    events() {
      return this.chunks.filter((c) => c.startsWith('data: ')).map((c) => JSON.parse(c.slice(6)));
    },
  };
}

test("a failed job's last event is the error body, redacted, and its streams end", () => {
  const store = createJobStore((r) => r);
  store.createJob('j1', { kind: 'vm-create', title: 'Create a' });
  const stream = fakeStream();
  store.registerStream('j1', stream);
  store.failJob('j1', createAppError('LIBVIRT_ERROR', 'Failed to define the VM', 'cannot write /etc/libvirt/qemu/a.xml'));
  assert.deepEqual(stream.events().at(-1), {
    step: 'error',
    error: 'LIBVIRT_ERROR',
    detail: 'Failed to define the VM: cannot write <path>',
  });
  assert.equal(stream.ended, true);
});

test('an error without a code fails the job as INTERNAL_ERROR', () => {
  const store = createJobStore((r) => r);
  store.createJob('j2', { kind: 'vm-create', title: 'Create b' });
  store.failJob('j2', new Error('boom'));
  const late = fakeStream();
  store.registerStream('j2', late);
  assert.deepEqual(late.events().at(-1), { step: 'error', error: 'INTERNAL_ERROR', detail: 'boom' });
  assert.equal(late.ended, true);
});
