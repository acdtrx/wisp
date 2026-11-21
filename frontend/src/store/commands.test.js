import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installBrowser } from '../testing/fakeBrowser.js';

installBrowser();
const { createRunCommand } = await import('./commands.js');

/** A run whose job wait the test settles by hand, logging the order. */
function harness() {
  const log = [];
  const pending = {};
  const run = createRunCommand({
    awaitJob: (jobId) => {
      log.push(`job:${jobId}`);
      return new Promise((resolve, reject) => { pending.job = { resolve, reject }; });
    },
  });
  return { run, log, pending };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a job command answers its ack, and ends when the job ended, with its result', async () => {
  const { run, log, pending } = harness();
  let acked = null;
  let done = false;
  const result = run(async () => ({ jobId: 'j1' }), { job: true, onAck: (ack) => { acked = ack.jobId; } })
    .then((r) => { done = true; return r; });
  await settle();
  assert.equal(acked, 'j1');
  assert.deepEqual(log, ['job:j1']);
  assert.equal(done, false);
  pending.job.resolve({ count: 3 });
  assert.deepEqual(await result, { count: 3 });
});

test('a failed or cancelled job fails the command', async () => {
  const { run, pending } = harness();
  const result = run(async () => ({ jobId: 'j2' }), { job: true });
  await settle();
  const cancelled = new Error('The job was cancelled before it finished');
  pending.job.reject(cancelled);
  await assert.rejects(result, cancelled);
});

test('a command that is not a job ends at its answer', async () => {
  const { run, log } = harness();
  assert.equal(await run(async () => 'ack'), 'ack');
  assert.deepEqual(log, []);
});

test('a refused command fails before any job is waited for', async () => {
  const { run, log } = harness();
  const refused = new Error('409');
  await assert.rejects(run(async () => { throw refused; }, { job: true }), refused);
  assert.deepEqual(log, []);
});
