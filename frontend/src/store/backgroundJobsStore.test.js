import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { installBrowser, installFetch, respondWithStream, settle } from '../testing/fakeBrowser.js';

let net;
let store;
let awaitJob;
let workloadBusyJob;
let workloadBackupJob;
let JOB_KIND;
let ApiError;
let loaded = 0;

beforeEach(async () => {
  installBrowser();
  net = installFetch();
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  loaded += 1;
  ({ useBackgroundJobsStore: store, awaitJob, workloadBusyJob, workloadBackupJob } = await import(`./backgroundJobsStore.js?test=${loaded}`));
  ({ JOB_KIND } = await import('../api/jobs.js'));
  ({ ApiError } = await import('../api/errors.js'));
});

afterEach(() => {
  // The last topic subscriber leaving closes the shared events stream, so the next test opens its own.
  store.getState().disconnect();
  mock.timers.reset();
});

const progressUrl = (jobId) => `/api/jobs/${jobId}/progress`;

/** Connect the store to the `jobs` topic; returns a sender of `{ jobs }` frames. */
async function connectTopic() {
  store.getState().connect();
  const stream = respondWithStream(await net.next('/api/events'));
  await settle();
  return async (jobs) => {
    stream.frame({ topic: 'jobs', data: { jobs } });
    await settle();
  };
}

const row = (jobId, fields = {}) => ({
  jobId, kind: 'vm-start', title: `Start ${jobId}`, subject: null, status: 'running', createdAt: 1000, ...fields,
});

/** Wait for job `jobId` by its ack, without the topic: its outcome (`{ value }` or `{ error }`) and its progress request. */
async function awaitAck(jobId) {
  const outcome = awaitJob(jobId).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  const request = await net.nextExact(progressUrl(jobId));
  return { outcome, request };
}

test('topic frames are the list: rows appear with their subject, end, and leave when the server drops them', async () => {
  const send = await connectTopic();
  const web = { type: 'vm', name: 'web' };

  await send([row('j1', { kind: JOB_KIND.VM_BACKUP, title: 'Backup web', subject: web }), row('j2', { kind: 'some-future-kind', title: 'Something new' })]);
  let { jobs } = store.getState();
  assert.deepEqual(
    { kind: jobs.j1.kind, title: jobs.j1.title, subject: jobs.j1.subject, status: jobs.j1.status, createdAt: jobs.j1.createdAt },
    { kind: 'vm-backup', title: 'Backup web', subject: web, status: 'running', createdAt: 1000 },
  );
  assert.equal(jobs.j2.title, 'Something new');
  assert.equal(workloadBusyJob(jobs, web)?.jobId, 'j1');
  // Every listed job is followed on the one progress URL.
  await net.nextExact(progressUrl('j1'));
  await net.nextExact(progressUrl('j2'));

  await send([row('j1', { subject: web, status: 'done' }), row('j2')]);
  ({ jobs } = store.getState());
  assert.equal(jobs.j1.status, 'done');
  assert.equal(workloadBusyJob(jobs, web), null);

  await send([row('j2')]);
  assert.deepEqual(Object.keys(store.getState().jobs), ['j2']);
});

test("a listed job's progress follows its stream; its terminal event ends the row before the topic does", async () => {
  const send = await connectTopic();
  const web = { type: 'vm', name: 'web' };
  await send([row('p1', { subject: web })]);
  const stream = respondWithStream(await net.nextExact(progressUrl('p1')));
  await settle();

  stream.frame({ step: 'copying', percent: 40, currentFile: 'disk0.qcow2' });
  await settle();
  let job = store.getState().jobs.p1;
  assert.deepEqual({ step: job.step, percent: job.percent, detail: job.detail }, { step: 'copying', percent: 40, detail: 'disk0.qcow2' });

  stream.frame({ step: 'done', result: { name: 'web' } });
  await settle();
  job = store.getState().jobs.p1;
  assert.equal(job.status, 'done');
  assert.deepEqual(job.result, { name: 'web' });
  assert.equal(workloadBusyJob(store.getState().jobs, web), null);

  // A frame sent before the job ended does not bring it back to running.
  await send([row('p1', { subject: web })]);
  assert.equal(store.getState().jobs.p1.status, 'done');
});

test('awaitJob follows a job the topic has not listed yet, and the row it later gets shares that stream', async () => {
  const send = await connectTopic();
  const { outcome, request } = await awaitAck('a1');
  const stream = respondWithStream(request);
  await settle();
  stream.frame({ step: 'starting', percent: 10 });
  await settle();
  assert.equal(store.getState().jobs.a1, undefined);

  await send([row('a1')]);
  assert.equal(store.getState().jobs.a1.step, 'starting');
  assert.equal(net.made(progressUrl('a1')).length, 1);

  stream.frame({ step: 'done', result: { count: 3 } });
  const { value } = await outcome;
  assert.deepEqual(value, { count: 3 });
});

test("a job's error event becomes an ApiError on its row, and awaitJob rejects with it", async () => {
  const send = await connectTopic();
  await send([row('e1')]);
  // The topic opened the stream; awaitJob shares it.
  const { outcome, request } = await awaitAck('e1');
  assert.equal(net.made(progressUrl('e1')).length, 1);
  const stream = respondWithStream(request);
  await settle();
  stream.frame({ step: 'error', error: 'VM_START_FAILED', detail: 'qemu exited' });
  await settle();

  const job = store.getState().jobs.e1;
  assert.equal(job.status, 'error');
  assert.ok(job.error instanceof ApiError);
  assert.deepEqual({ status: job.error.status, code: job.error.code, detail: job.error.detail }, { status: null, code: 'VM_START_FAILED', detail: 'qemu exited' });
  const { error } = await outcome;
  assert.equal(error, job.error);
});

test('a cancelled job ends its row with no error, and awaitJob resolves with no result', async () => {
  const send = await connectTopic();
  await send([row('c1', { kind: 'os-update-check' })]);
  const outcome = awaitJob('c1').then((value) => ({ value }), (error) => ({ error }));
  const stream = respondWithStream(await net.nextExact(progressUrl('c1')));
  await settle();
  stream.frame({ step: 'cancelled' });
  await settle();

  const job = store.getState().jobs.c1;
  assert.equal(job.status, 'cancelled');
  assert.equal(job.error, null);
  assert.deepEqual(await outcome, { value: undefined });
});

test('a dropped progress stream reconnects and replays; the wait goes on', async () => {
  const { outcome, request } = await awaitAck('d1');
  const first = respondWithStream(request);
  await settle();
  first.frame({ step: 'starting' });
  first.drop();
  await settle();

  mock.timers.tick(5_000);
  const replay = respondWithStream(await net.nextExact(progressUrl('d1')));
  await settle();
  replay.frame({ step: 'starting' });
  replay.frame({ step: 'done', result: { ok: true } });
  const { value } = await outcome;
  assert.deepEqual(value, { ok: true });
});

test('a 404 on the progress stream rejects awaitJob with JOB_GONE', async () => {
  const { outcome, request } = await awaitAck('g1');
  request.respond(new Response(JSON.stringify({ error: 'JOB_NOT_FOUND', detail: 'No job with id "g1"' }), { status: 404 }));
  await settle();

  const { error } = await outcome;
  assert.ok(error instanceof ApiError);
  assert.equal(error.code, 'JOB_GONE');
});

test('another refusal of the progress stream rejects awaitJob with its error', async () => {
  const { outcome, request } = await awaitAck('r1');
  request.respond(new Response(JSON.stringify({ error: 'SCOPE_INSUFFICIENT', detail: 'Admin scope needed' }), { status: 403 }));
  await settle();

  const { error } = await outcome;
  assert.ok(error instanceof ApiError);
  assert.equal(error.code, 'SCOPE_INSUFFICIENT');
  assert.equal(error.status, 403);
});

test('a dismissed row leaves the tray and stays out until the server drops it', async () => {
  const send = await connectTopic();
  await send([row('x1', { status: 'done' })]);
  store.getState().dismissJob('x1');
  assert.equal(store.getState().jobs.x1, undefined);

  await send([row('x1', { status: 'done' })]);
  assert.equal(store.getState().jobs.x1, undefined);
});

test('a backup or restore-in-place job is a backup job; a start busies the workload but is none', async () => {
  const send = await connectTopic();
  await send([
    row('s1', { kind: 'vm-start', subject: { type: 'vm', name: 'web' } }),
    row('r1', { kind: JOB_KIND.CONTAINER_RESTORE, subject: { type: 'container', name: 'db' } }),
    row('k1', { kind: JOB_KIND.VM_BACKUP, subject: { type: 'vm', name: 'api' } }),
  ]);
  const { jobs } = store.getState();

  assert.equal(workloadBusyJob(jobs, { type: 'vm', name: 'web' })?.jobId, 's1');
  assert.equal(workloadBusyJob(jobs, { type: 'container', name: 'web' }), null);
  assert.equal(workloadBackupJob(jobs, { type: 'vm', name: 'web' }), null);
  assert.equal(workloadBackupJob(jobs, { type: 'container', name: 'db' })?.jobId, 'r1');
  assert.equal(workloadBackupJob(jobs, { type: 'vm', name: 'api' })?.jobId, 'k1');
  assert.equal(workloadBackupJob(jobs, { type: 'container', name: 'api' }), null);
});
