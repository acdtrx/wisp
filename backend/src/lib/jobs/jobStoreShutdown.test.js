/*
 * The starter once shutdown has begun. A file of its own: the refusal lasts
 * for the life of the process, so it would refuse every test after it.
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

import { ERROR_STATUS } from '../errorCodes.js';
import { acquireVmOperationLock } from '../vmOperationLock.js';
import { listJobs, refuseNewJobs, startJob } from './jobStore.js';
import { JOB_KIND } from '../../../../shared/wireNames.js';

const log = { debug() {}, info() {}, warn() {}, error() {} };
const refused = (err) => err.code === 'SHUTTING_DOWN' && ERROR_STATUS[err.code] === 503;

const running = Promise.withResolvers();
const pendingCheck = Promise.withResolvers();
let ack;
let startDuringCheck;
let ranAfterCheck = false;

before(async () => {
  ack = await startJob({ kind: JOB_KIND.OS_UPDATE_CHECK, title: 'Check', shared: true, log, run: () => running.promise });
  // Claims b1's lock and awaits its check, which is still pending when shutdown begins.
  startDuringCheck = startJob({
    kind: JOB_KIND.VM_START,
    title: 'Start b1',
    subject: { type: 'vm', name: 'b1' },
    check: () => pendingCheck.promise,
    log,
    run: async () => { ranAfterCheck = true; },
  });
  refuseNewJobs();
});

test('once shutdown has begun, a start is refused with SHUTTING_DOWN and no job is created', async () => {
  let ran = false;
  await assert.rejects(startJob({
    kind: JOB_KIND.VM_START, title: 'Start a1', subject: { type: 'vm', name: 'a1' }, log, run: async () => { ran = true; },
  }), refused);
  await assert.rejects(startJob({ kind: JOB_KIND.OS_UPDATE_CHECK, title: 'Check', shared: true, log, run: async () => {} }), refused);
  assert.equal(ran, false);
  assert.deepEqual(listJobs().map((j) => j.jobId), [ack.jobId]);
  assert.equal(listJobs()[0].status, 'running');
  running.resolve();
});

test('a start whose check was pending when shutdown began is refused once the check passes, its lock released', async () => {
  pendingCheck.resolve();
  await assert.rejects(startDuringCheck, refused);
  assert.equal(ranAfterCheck, false);
  assert.deepEqual(listJobs().filter((j) => j.kind === JOB_KIND.VM_START), []);
  acquireVmOperationLock('b1', 'start')();
});
