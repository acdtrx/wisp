/*
 * The starter once shutdown has begun. A file of its own: the refusal lasts
 * for the life of the process, so it would refuse every test after it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ERROR_STATUS } from '../errorCodes.js';
import { listJobs, refuseNewJobs, startJob } from './jobStore.js';

const log = { debug() {}, info() {}, warn() {}, error() {} };

test('once shutdown has begun, a start is refused with SHUTTING_DOWN and no job is created', async () => {
  const running = Promise.withResolvers();
  const ack = await startJob({ kind: 'os-update-check', title: 'Check', shared: true, log, run: () => running.promise });

  refuseNewJobs();

  let ran = false;
  const refused = (err) => err.code === 'SHUTTING_DOWN' && ERROR_STATUS[err.code] === 503;
  await assert.rejects(startJob({
    kind: 'vm-start', title: 'Start a1', subject: { type: 'vm', name: 'a1' }, log, run: async () => { ran = true; },
  }), refused);
  await assert.rejects(startJob({ kind: 'os-update-check', title: 'Check', shared: true, log, run: async () => {} }), refused);
  assert.equal(ran, false);
  assert.deepEqual(listJobs().map((j) => j.jobId), [ack.jobId]);
  assert.equal(listJobs()[0].status, 'running');
  running.resolve();
});
