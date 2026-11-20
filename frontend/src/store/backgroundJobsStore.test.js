import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { installBrowser, installFetch, respondWithStream, settle } from '../testing/fakeBrowser.js';

let net;
let store;
let awaitJob;
let JOB_KIND;
let ApiError;
let loaded = 0;

beforeEach(async () => {
  installBrowser();
  net = installFetch();
  // Mocked: a finished row arms the store's 5-minute prune timer.
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  loaded += 1;
  ({ useBackgroundJobsStore: store, awaitJob } = await import(`./backgroundJobsStore.js?test=${loaded}`));
  ({ JOB_KIND } = await import('../api/jobProgress.js'));
  ({ ApiError } = await import('../api/errors.js'));
});

afterEach(() => {
  mock.timers.reset();
});

const progressUrl = (jobId) => `/api/jobs/${jobId}/progress`;

/** Follow job `jobId` with awaitJob: its outcome (`{ value }` or `{ error }`) and its progress request. */
async function follow(jobId) {
  const outcome = awaitJob(JOB_KIND.VM_START, { jobId, title: `Start ${jobId}` }).then(
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

test("awaitJob resolves with the job's done event", async () => {
  const { outcome, request } = await follow('j3');
  const stream = respondWithStream(request);
  await settle();
  stream.frame({ step: 'done', count: 3 });
  await settle();

  const { value } = await outcome;
  assert.deepEqual(value, { step: 'done', count: 3 });
});
