import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAppError } from '../appErrors.js';
import { acquireVmOperationLock } from '../vmOperationLock.js';
import { acquireContainerOperationLock } from '../containerOperationLock.js';
import {
  startJob, listJobs, readJob, isJobRunning, hasJob, registerJobStream,
  countJobsThatMustFinish, cancelInterruptibleJobs, subscribeJobsChange, sweepExpiredJobs, whenJobEnds,
} from './jobStore.js';

/** A logger that records each line as `[level, fields, message]`. */
function fakeLog() {
  const lines = [];
  const at = (level) => (fields, message) => lines.push([level, fields, message]);
  return { lines, info: at('info'), warn: at('warn'), error: at('error'), debug: at('debug') };
}

/**
 * A stand-in for a response stream: records the events written to it and
 * whether it ended; `onEvent` runs as each event is written.
 */
function fakeStream(onEvent) {
  return {
    events: [],
    ended: false,
    write(chunk) {
      if (!chunk.startsWith('data: ')) return;
      const event = JSON.parse(chunk.slice(6));
      this.events.push(event);
      onEvent?.(event);
    },
    end() { this.ended = true; },
  };
}

/** A promise with its resolve and reject, for a run the test ends by hand. */
const deferred = () => Promise.withResolvers();

/** Wait for every queued microtask and the next macrotask: a run's settlement is processed. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const rowsFor = (name) => listJobs().filter((j) => j.subject?.name === name);

test('a job is created with its row, and its result is the done event', async () => {
  const log = fakeLog();
  const ack = await startJob({
    kind: 'vm-start', title: 'Start a1', subject: { type: 'vm', name: 'a1' }, log, run: async () => ({ name: 'a1' }),
  });
  assert.match(ack.jobId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.deepEqual(ack, { jobId: ack.jobId, kind: 'vm-start', title: 'Start a1', subject: { type: 'vm', name: 'a1' } });
  assert.ok(hasJob(ack.jobId));
  await settle();
  const [row] = rowsFor('a1');
  assert.deepEqual(row, {
    jobId: ack.jobId, kind: 'vm-start', title: 'Start a1', subject: { type: 'vm', name: 'a1' }, status: 'done', createdAt: row.createdAt,
  });
  assert.equal(typeof row.createdAt, 'number');
  const late = fakeStream();
  registerJobStream(ack.jobId, late);
  assert.deepEqual(late.events.at(-1), { step: 'done', result: { name: 'a1' } });
  assert.equal(late.ended, true);
  assert.deepEqual(readJob(ack.jobId), { ...row, result: { name: 'a1' } });
  assert.deepEqual(log.lines.map(([level, , message]) => [level, message]), [
    ['info', 'Background job started'],
    ['info', 'Background job completed'],
  ]);
  assert.deepEqual(log.lines[0][1].subject, { type: 'vm', name: 'a1' });
});

test("the subject's lock is held for the run and released before the terminal event", async () => {
  const run = deferred();
  const { jobId } = await startJob({
    kind: 'vm-backup', title: 'Backup a2', subject: { type: 'vm', name: 'a2' }, log: fakeLog(), run: () => run.promise,
  });
  assert.throws(() => acquireVmOperationLock('a2', 'start'), { code: 'VM_BUSY', message: /backup in progress/ });
  // A container of the same name is another workload.
  acquireContainerOperationLock('a2', 'start')();

  let freeOnDone = null;
  const stream = fakeStream((event) => {
    if (event.step !== 'done') return;
    try {
      acquireVmOperationLock('a2', 'start')();
      freeOnDone = true;
    } catch {
      freeOnDone = false;
    }
  });
  registerJobStream(jobId, stream);
  run.resolve({ timestamp: 't' });
  await settle();
  assert.equal(freeOnDone, true);
  assert.equal(stream.ended, true);
});

test('a start on a held subject throws the busy code at once and creates no job', async () => {
  const release = acquireContainerOperationLock('c3', 'restore');
  const before = listJobs().length;
  let ran = false;
  await assert.rejects(
    startJob({
      kind: 'container-start', title: 'Start c3', subject: { type: 'container', name: 'c3' }, log: fakeLog(),
      check: () => { ran = true; },
      run: async () => ({}),
    }),
    { code: 'CONTAINER_BUSY', message: /restore in progress/ },
  );
  assert.equal(ran, false);
  assert.equal(listJobs().length, before);
  release();
});

test("a failed check releases the lock, creates no job and is thrown to the caller", async () => {
  const before = listJobs().length;
  await assert.rejects(
    startJob({
      kind: 'vm-delete', title: 'Delete a4', subject: { type: 'vm', name: 'a4' }, log: fakeLog(),
      check: async () => { throw createAppError('VM_NOT_FOUND', 'VM "a4" not found'); },
      run: async () => ({}),
    }),
    { code: 'VM_NOT_FOUND' },
  );
  assert.equal(listJobs().length, before);
  acquireVmOperationLock('a4', 'start')();
});

test('a shared start while one runs answers the running job and starts nothing', async () => {
  const run = deferred();
  let runs = 0;
  const start = (title) => startJob({
    kind: 'os-update-check', title, shared: true, log: fakeLog(),
    run: () => { runs += 1; return run.promise; },
  });
  const first = await start('Check for OS updates');
  const second = await start('Check again');
  assert.deepEqual(second, first);
  await settle();
  assert.equal(runs, 1);
  assert.equal(isJobRunning('os-update-check'), true);
  run.resolve({ count: 2 });
  await settle();
  assert.equal(isJobRunning('os-update-check'), false);
  const third = await start('Check for OS updates');
  assert.notEqual(third.jobId, first.jobId);
});

test('a failed run ends with the error body, redacted, and an unexpected one logs its stack', async () => {
  const log = fakeLog();
  const { jobId } = await startJob({
    kind: 'vm-create', title: 'Create a5', subject: { type: 'vm', name: 'a5' }, log,
    run: async () => { throw createAppError('LIBVIRT_ERROR', 'Failed to define the VM', 'cannot write /etc/libvirt/qemu/a5.xml'); },
  });
  const stream = fakeStream();
  registerJobStream(jobId, stream);
  await settle();
  const body = { error: 'LIBVIRT_ERROR', detail: 'Failed to define the VM: cannot write <path>' };
  assert.deepEqual(stream.events.at(-1), { step: 'error', ...body });
  assert.equal(stream.ended, true);
  assert.equal(readJob(jobId).status, 'error');
  assert.deepEqual({ error: readJob(jobId).error, detail: readJob(jobId).detail }, body);
  assert.equal(log.lines.at(-1)[0], 'error');
  assert.ok(log.lines.at(-1)[1].err instanceof Error);

  const expected = fakeLog();
  const busy = await startJob({
    kind: 'vm-start', title: 'Start a5', subject: { type: 'vm', name: 'a5' }, log: expected,
    run: async () => { throw createAppError('VM_ALREADY_RUNNING', 'VM "a5" is already running'); },
  });
  await settle();
  assert.equal(readJob(busy.jobId).error, 'VM_ALREADY_RUNNING');
  assert.equal(expected.lines.at(-1)[0], 'warn');
});

test('a thrown value without a code fails the job as INTERNAL_ERROR', async () => {
  const { jobId } = await startJob({
    kind: 'library-download', title: 'x', log: fakeLog(), run: async () => { throw new Error('boom'); },
  });
  await settle();
  assert.deepEqual({ error: readJob(jobId).error, detail: readJob(jobId).detail }, { error: 'INTERNAL_ERROR', detail: 'boom' });
});

test('a running job reports its latest progress, and events after its end are dropped', async () => {
  const run = deferred();
  let report;
  const { jobId } = await startJob({
    kind: 'container-backup', title: 'Backup c6', subject: { type: 'container', name: 'c6' }, log: fakeLog(),
    run: (r) => { report = r; return run.promise; },
  });
  await settle();
  report({ step: 'archiving', percent: 10 });
  report({ step: 'archiving', percent: 20 });
  assert.deepEqual(readJob(jobId).progress, { step: 'archiving', percent: 20 });
  assert.equal(readJob(jobId).status, 'running');
  run.resolve({ timestamp: 't6' });
  await settle();
  report({ step: 'late' });
  const replay = fakeStream();
  registerJobStream(jobId, replay);
  assert.deepEqual(replay.events, [{ step: 'archiving', percent: 20 }, { step: 'done', result: { timestamp: 't6' } }]);
});

test('jobs are listed newest first, and the kind-running query reads kind and subject', async () => {
  const runs = [deferred(), deferred()];
  const a = await startJob({
    kind: 'container-stop', title: 'Stop c7', subject: { type: 'container', name: 'c7' }, log: fakeLog(), run: () => runs[0].promise,
  });
  const b = await startJob({
    kind: 'container-start', title: 'Start c7b', subject: { type: 'container', name: 'c7b' }, log: fakeLog(), run: () => runs[1].promise,
  });
  const ids = listJobs().map((j) => j.jobId);
  assert.ok(ids.indexOf(b.jobId) < ids.indexOf(a.jobId));
  assert.equal(ids[0], b.jobId);
  assert.equal(isJobRunning('container-stop', { type: 'container', name: 'c7' }), true);
  assert.equal(isJobRunning('container-stop', { type: 'container', name: 'c7b' }), false);
  assert.equal(isJobRunning('container-stop', { type: 'vm', name: 'c7' }), false);
  assert.equal(isJobRunning('container-stop'), true);
  runs[0].resolve({ name: 'c7' });
  runs[1].resolve({ name: 'c7b' });
  await settle();
  assert.equal(isJobRunning('container-stop'), false);
});

test('a kind and its subject must match', async () => {
  await assert.rejects(startJob({ kind: 'vm-start', title: 't', log: fakeLog(), run: async () => ({}) }), /acts on a vm/);
  await assert.rejects(
    startJob({ kind: 'vm-start', title: 't', subject: { type: 'container', name: 'x' }, log: fakeLog(), run: async () => ({}) }),
    /acts on a vm/,
  );
  await assert.rejects(
    startJob({ kind: 'os-upgrade', title: 't', subject: { type: 'vm', name: 'x' }, log: fakeLog(), run: async () => ({}) }),
    /has no subject/,
  );
  await assert.rejects(startJob({ kind: 'backup', title: 't', log: fakeLog(), run: async () => ({}) }), /Unknown job kind/);
});

test('a start with bad arguments throws before it takes a lock or creates a row', async () => {
  const before = listJobs().length;
  const start = (opts) => startJob({
    kind: 'vm-backup', title: 'Backup a8', subject: { type: 'vm', name: 'a8' }, log: fakeLog(), run: async () => ({}), ...opts,
  });
  await assert.rejects(start({ log: undefined }), /needs a logger/);
  await assert.rejects(start({ log: { info() {} } }), /needs a logger/);
  await assert.rejects(start({ run: undefined }), /needs a run/);
  await assert.rejects(start({ title: '' }), /needs a title/);
  await assert.rejects(start({ check: 'exists' }), /check is a function/);
  assert.equal(listJobs().length, before);
  acquireVmOperationLock('a8', 'start')();
});

test('two starts in one tick: the second answers its refusal, and one job exists', async () => {
  const run = deferred();
  const start = () => startJob({
    kind: 'os-upgrade', title: 'Install OS updates', log: fakeLog(),
    check: () => {
      if (isJobRunning('os-upgrade')) throw createAppError('UPDATE_BUSY', 'An OS upgrade is already in progress');
    },
    run: () => run.promise,
  });
  const [first, second] = await Promise.allSettled([start(), start()]);
  assert.equal(first.status, 'fulfilled');
  assert.equal(second.status, 'rejected');
  assert.equal(second.reason.code, 'UPDATE_BUSY');
  assert.equal(listJobs().filter((j) => j.kind === 'os-upgrade' && j.status === 'running').length, 1);
  run.resolve({ ok: true });
  await settle();
});

test('a job without a subject is refused an async check: nothing holds its claim across an await', async () => {
  const before = listJobs().length;
  await assert.rejects(
    startJob({ kind: 'os-upgrade', title: 't', log: fakeLog(), check: async () => {}, run: async () => ({}) }),
    /needs a synchronous check/,
  );
  assert.equal(listJobs().length, before);
});

test('two shared starts in one tick, each past its check, end with one job and both answer its ack', async () => {
  const run = deferred();
  let checks = 0;
  let runs = 0;
  const start = () => startJob({
    kind: 'os-update-check', title: 'Check for OS updates', shared: true, log: fakeLog(),
    check: () => { checks += 1; },
    run: () => { runs += 1; return run.promise; },
  });
  const [a, b] = await Promise.all([start(), start()]);
  assert.deepEqual(b, a);
  assert.deepEqual(a, { jobId: a.jobId, kind: 'os-update-check', title: 'Check for OS updates', subject: null });
  assert.equal(checks, 1);
  await settle();
  assert.equal(runs, 1);
  assert.equal(listJobs().filter((j) => j.kind === 'os-update-check' && j.status === 'running').length, 1);
  run.resolve({ count: 0 });
  await settle();
});

test('a shared start joins only a running job that covers its scope', async () => {
  const runs = [];
  const start = (ref) => startJob({
    kind: 'container-image-update-check', title: ref ? `Check ${ref}` : 'Check OCI image updates',
    shared: true, scope: ref, log: fakeLog(),
    run: () => { const d = deferred(); runs.push(d); return d.promise; },
  });
  // One image first: a check of every image does not join it, a check of that image does.
  const one = await start('nginx:1');
  const all = await start(null);
  assert.notEqual(all.jobId, one.jobId);
  assert.equal((await start('nginx:1')).jobId, one.jobId);
  // Every image running: a check of any one image joins it.
  for (const d of runs) d.resolve({});
  await settle();
  const every = await start(null);
  assert.equal((await start('redis:7')).jobId, every.jobId);
  assert.equal((await start(null)).jobId, every.jobId);
  // One image running alone: another image starts its own.
  for (const d of runs) d.resolve({});
  await settle();
  const first = await start('nginx:1');
  assert.notEqual((await start('redis:7')).jobId, first.jobId);
  for (const d of runs) d.resolve({});
  await settle();
});

test('an interruptible job cut ends cancelled, logged at info without a stack, and is not counted as must-finish', async () => {
  const log = fakeLog();
  const mustFinish = deferred();
  await startJob({ kind: 'library-download', title: 'must finish', log: fakeLog(), run: (_report, signal) => {
    assert.equal(signal, undefined);
    return mustFinish.promise;
  } });
  const before = countJobsThatMustFinish();
  const { jobId } = await startJob({
    kind: 'os-update-check', title: 'Check for OS updates', shared: true, interruptible: true, log,
    run: (_report, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  });
  await settle();
  assert.equal(countJobsThatMustFinish(), before);
  const stream = fakeStream();
  registerJobStream(jobId, stream);
  assert.ok(await cancelInterruptibleJobs() >= 1);
  assert.deepEqual(stream.events.at(-1), { step: 'cancelled' });
  assert.equal(stream.ended, true);
  const job = readJob(jobId);
  assert.equal(job.status, 'cancelled');
  assert.equal('error' in job, false);
  assert.deepEqual(log.lines.at(-1), ['info', { jobId, kind: 'os-update-check', title: 'Check for OS updates', subject: null }, 'Background job cancelled']);
  // The job that must finish was not cut.
  assert.equal(countJobsThatMustFinish(), before);
  mustFinish.resolve({});
  await settle();
});

test('a cancel writes the terminal event to a registered stream, then ends it, before it settles', async () => {
  const { jobId } = await startJob({
    kind: 'os-update-check', title: 'Check for OS updates', shared: true, interruptible: true, log: fakeLog(),
    run: (_report, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  });
  let endedAtCancelled = null;
  const stream = fakeStream((event) => {
    if (event.step === 'cancelled') endedAtCancelled = stream.ended;
  });
  registerJobStream(jobId, stream);
  const cancelling = cancelInterruptibleJobs();
  assert.equal(stream.ended, false, 'the stream stays open until the job has ended');
  await cancelling;
  assert.equal(endedAtCancelled, false, 'the cancelled event is written before the stream ends');
  assert.equal(stream.ended, true);
  assert.equal(readJob(jobId).status, 'cancelled');
});

test('the store announces each list change — create, end, expiry — and no progress event', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  let changes = 0;
  const unsubscribe = subscribeJobsChange(() => { changes += 1; });
  const run = deferred();
  let report;
  await startJob({
    kind: 'container-backup', title: 'Backup c9', subject: { type: 'container', name: 'c9' }, log: fakeLog(),
    run: (r) => { report = r; return run.promise; },
  });
  assert.equal(changes, 1);
  await settle();
  report({ step: 'archiving', percent: 10 });
  report({ step: 'archiving', percent: 20 });
  assert.equal(changes, 1);
  run.resolve({ timestamp: 't9' });
  await settle();
  assert.equal(changes, 2);
  assert.equal(sweepExpiredJobs(), 0);
  assert.equal(changes, 2);
  t.mock.timers.tick(5 * 60 * 1000);
  assert.ok(sweepExpiredJobs() >= 1);
  assert.equal(changes, 3);
  assert.equal(rowsFor('c9').length, 0);
  unsubscribe();
});

test('a list change handler that throws is logged and the start still answers', async () => {
  const log = fakeLog();
  const unsubscribe = subscribeJobsChange(() => { throw new Error('handler broke'); });
  const ack = await startJob({ kind: 'library-download', title: 'x', log, run: async () => ({}) });
  unsubscribe();
  assert.ok(hasJob(ack.jobId));
  assert.ok(log.lines.some(([level, , message]) => level === 'warn' && message === 'Job list change handler failed'));
  await settle();
});

test('whenJobEnds settles with the end status, at once for an ended job, and null for an unknown one', async () => {
  const run = deferred();
  const { jobId } = await startJob({
    kind: 'container-backup', title: 'Backup w1', subject: { type: 'container', name: 'w1' }, log: fakeLog(), run: () => run.promise,
  });
  let ended = null;
  const waiting = whenJobEnds(jobId).then((status) => { ended = status; });
  await settle();
  assert.equal(ended, null, 'still running');
  run.reject(createAppError('BACKUP_EXISTS', 'exists'));
  await waiting;
  assert.equal(ended, 'error');
  assert.equal(await whenJobEnds(jobId), 'error');

  const done = await startJob({ kind: 'vm-start', title: 'Start w2', subject: { type: 'vm', name: 'w2' }, log: fakeLog(), run: async () => null });
  assert.equal(await whenJobEnds(done.jobId), 'done');
  assert.equal(await whenJobEnds('no-such-job'), null);
});
