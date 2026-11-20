import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { installBrowser, installFetch, jsonResponse, respondWithStream, settle } from '../testing/fakeBrowser.js';

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
  // Mocked: a finished row arms the store's 5-minute prune timer.
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  loaded += 1;
  ({ useBackgroundJobsStore: store, awaitJob, workloadBusyJob, workloadBackupJob } = await import(`./backgroundJobsStore.js?test=${loaded}`));
  ({ JOB_KIND } = await import('../api/jobs.js'));
  ({ ApiError } = await import('../api/errors.js'));
});

afterEach(() => {
  mock.timers.reset();
});

const progressUrl = (jobId) => `/api/jobs/${jobId}/progress`;

/** Add job `jobId` and wait for it: its outcome (`{ value }` or `{ error }`) and its progress request. */
async function follow(jobId, subject = null) {
  store.getState().addJob({ jobId, kind: JOB_KIND.VM_START, title: `Start ${jobId}`, subject });
  const outcome = awaitJob(jobId).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  const request = await net.nextExact(progressUrl(jobId));
  return { outcome, request };
}

test("a job's error event becomes an ApiError on its row, and awaitJob rejects with it", async () => {
  const { outcome, request } = await follow('j1');
  const stream = respondWithStream(request);
  await settle();
  stream.frame({ step: 'starting', percent: 10 });
  stream.frame({ step: 'error', error: 'VM_START_FAILED', detail: 'qemu exited' });
  await settle();

  const row = store.getState().jobs.j1;
  assert.equal(row.status, 'error');
  assert.ok(row.error instanceof ApiError);
  assert.deepEqual({ status: row.error.status, code: row.error.code, detail: row.error.detail }, { status: null, code: 'VM_START_FAILED', detail: 'qemu exited' });

  const { error } = await outcome;
  assert.equal(error, row.error);
});

test('a job the server no longer knows rejects awaitJob with JOB_GONE', async () => {
  const { outcome, request } = await follow('j2');
  request.respond(new Response(null, { status: 404 }));
  await settle();

  const { error } = await outcome;
  assert.ok(error instanceof ApiError);
  assert.equal(error.code, 'JOB_GONE');
  assert.equal(store.getState().jobs.j2, undefined);
});

test('awaitJob on a job never added rejects with JOB_GONE', async () => {
  const error = await awaitJob('nope').then(() => null, (err) => err);
  assert.equal(error?.code, 'JOB_GONE');
});

test("awaitJob resolves with the done event's result, which the row holds", async () => {
  const { outcome, request } = await follow('j3');
  const stream = respondWithStream(request);
  await settle();
  stream.frame({ step: 'done', result: { count: 3 } });
  await settle();

  const { value } = await outcome;
  assert.deepEqual(value, { count: 3 });
  assert.deepEqual(store.getState().jobs.j3.result, { count: 3 });
});

test("a row keeps the latest event of each step, with the kind's own fields", async () => {
  const { request } = await follow('j4');
  const stream = respondWithStream(request);
  await settle();
  stream.frame({ step: 'checking', ref: 'a', index: 1, total: 2 });
  stream.frame({ step: 'skipped', ref: 'a', error: 'IMAGE_PULL_FAILED', detail: 'no route' });
  stream.frame({ step: 'checking', ref: 'b', index: 2, total: 2 });
  await settle();

  const { events } = store.getState().jobs.j4;
  assert.deepEqual(events.checking, { step: 'checking', ref: 'b', index: 2, total: 2 });
  assert.equal(events.skipped.ref, 'a');
});

test('hydration adds every listed job with its subject, an unknown kind included, each on the one progress URL', async () => {
  const hydrated = store.getState().hydrate();
  (await net.nextExact('/api/jobs')).respond(jsonResponse({
    jobs: [
      { jobId: 'h1', kind: JOB_KIND.VM_BACKUP, title: 'Backup web', subject: { type: 'vm', name: 'web' }, status: 'running', createdAt: 1000 },
      { jobId: 'h2', kind: 'some-future-kind', title: 'Something new', subject: null, status: 'running', createdAt: 2000 },
    ],
  }));
  await hydrated;

  const { jobs, hydrateFailed } = store.getState();
  assert.equal(hydrateFailed, false);
  assert.deepEqual(
    { kind: jobs.h1.kind, title: jobs.h1.title, subject: jobs.h1.subject, status: jobs.h1.status, startedAt: jobs.h1.startedAt },
    { kind: 'vm-backup', title: 'Backup web', subject: { type: 'vm', name: 'web' }, status: 'running', startedAt: 1000 },
  );
  assert.deepEqual({ kind: jobs.h2.kind, title: jobs.h2.title, subject: jobs.h2.subject }, { kind: 'some-future-kind', title: 'Something new', subject: null });
  await net.nextExact(progressUrl('h1'));
  await net.nextExact(progressUrl('h2'));
});

test('a running job busies its subject only: same name, other type stays free; a finished one frees it', async () => {
  const { request } = await follow('b1', { type: 'vm', name: 'web' });
  const vmWeb = { type: 'vm', name: 'web' };
  const containerWeb = { type: 'container', name: 'web' };

  assert.equal(workloadBusyJob(store.getState().jobs, vmWeb)?.jobId, 'b1');
  assert.equal(workloadBusyJob(store.getState().jobs, containerWeb), null);
  assert.equal(workloadBusyJob(store.getState().jobs, { type: 'vm', name: 'db' }), null);

  const stream = respondWithStream(request);
  await settle();
  stream.frame({ step: 'done', result: { name: 'web' } });
  await settle();

  assert.equal(workloadBusyJob(store.getState().jobs, vmWeb), null);
});

test("a finished job hydrated after a reload has no error until its replay brings it, and awaitJob waits for it", async () => {
  const hydrated = store.getState().hydrate();
  (await net.nextExact('/api/jobs')).respond(jsonResponse({
    jobs: [{ jobId: 'f1', kind: JOB_KIND.VM_START, title: 'Start web', subject: { type: 'vm', name: 'web' }, status: 'error', createdAt: 1000 }],
  }));
  await hydrated;

  const before = store.getState().jobs.f1;
  assert.equal(before.status, 'error');
  assert.equal(before.error, null);
  let settled = false;
  const outcome = awaitJob('f1').then(() => null, (err) => err).finally(() => { settled = true; });
  await settle();
  assert.equal(settled, false);

  const stream = respondWithStream(await net.nextExact(progressUrl('f1')));
  await settle();
  stream.frame({ step: 'error', error: 'VM_START_FAILED', detail: 'qemu exited' });
  await settle();

  const error = await outcome;
  assert.ok(error instanceof ApiError);
  assert.equal(error.detail, 'qemu exited');
  assert.equal(store.getState().jobs.f1.error, error);
});

test('a backup or restore-in-place job is a backup job; a start busies the workload but is none', async () => {
  const add = (jobId, kind, subject) => store.getState().addJob({ jobId, kind, title: jobId, subject });
  add('s1', JOB_KIND.VM_START, { type: 'vm', name: 'web' });
  add('r1', JOB_KIND.CONTAINER_RESTORE, { type: 'container', name: 'db' });
  add('k1', JOB_KIND.VM_BACKUP, { type: 'vm', name: 'api' });
  const { jobs } = store.getState();

  assert.equal(workloadBusyJob(jobs, { type: 'vm', name: 'web' })?.jobId, 's1');
  assert.equal(workloadBackupJob(jobs, { type: 'vm', name: 'web' }), null);
  assert.equal(workloadBackupJob(jobs, { type: 'container', name: 'db' })?.jobId, 'r1');
  assert.equal(workloadBackupJob(jobs, { type: 'vm', name: 'api' })?.jobId, 'k1');
  assert.equal(workloadBackupJob(jobs, { type: 'container', name: 'api' }), null);
});
