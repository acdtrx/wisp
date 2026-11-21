import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installBrowser } from '../testing/fakeBrowser.js';

installBrowser();
const { createRunCommand } = await import('./commands.js');

/** A run whose job wait and re-reads the test settles by hand, logging the order. */
function harness() {
  const log = [];
  const pending = {};
  const deferred = (name) => new Promise((resolve, reject) => { pending[name] = { resolve, reject }; });
  const run = createRunCommand({
    awaitJob: (jobId) => { log.push(`job:${jobId}`); return deferred('job'); },
    reread: (kind, id) => { log.push(`reread:${kind}:${id ?? ''}`); return deferred(`reread:${kind}`); },
  });
  return { run, log, pending };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a job command reads its records again only after the job ended, and ends when they landed', async () => {
  const { run, log, pending } = harness();
  let acked = null;
  let done = false;
  const result = run(async () => ({ jobId: 'j1' }), {
    job: true, rereads: [['mounts'], ['settings', 'x']], onAck: (ack) => { acked = ack.jobId; },
  }).then((r) => { done = true; return r; });
  await settle();
  assert.equal(acked, 'j1');
  assert.deepEqual(log, ['job:j1']);
  pending.job.resolve({ count: 3 });
  await settle();
  assert.deepEqual(log, ['job:j1', 'reread:mounts:', 'reread:settings:x']);
  pending['reread:mounts'].resolve();
  await settle();
  assert.equal(done, false);
  pending['reread:settings'].resolve();
  assert.deepEqual(await result, { count: 3 });
});

test('a failed job fails the command, and nothing is read again', async () => {
  const { run, log, pending } = harness();
  const result = run(async () => ({ jobId: 'j2' }), { job: true, rereads: [['mounts']] });
  await settle();
  const failure = new Error('job failed');
  pending.job.reject(failure);
  await assert.rejects(result, failure);
  assert.deepEqual(log, ['job:j2']);
});

test('a command that is not a job ends at its answer, then its re-reads', async () => {
  const { run, log } = harness();
  assert.equal(await run(async () => 'ack'), 'ack');
  assert.deepEqual(log, []);
});
