/*
 * The image archive upload's glue, with the container manager mocked (node --test
 * --experimental-test-module-mocks): the job starter is the real one. What the
 * import does with the archive in containerd is verified on a host.
 */
import { after, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createAppError } from './appErrors.js';
import { JOB_KIND } from '../../../shared/wireNames.js';

const dir = mkdtempSync(path.join(tmpdir(), 'wisp-image-import-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));

let staged = 0;
const imported = [];
/** Set by a test to hold the import until it resolves. */
let hold = null;
mock.module(new URL('./containerManager/index.js', import.meta.url).href, {
  exports: {
    newImageImportStagingPath: async () => path.join(dir, `.image-import-${staged += 1}.tar`),
    storeImagesFromArchive: async (archivePath) => {
      imported.push(archivePath);
      await hold;
      return { images: [{ name: 'localhost/myapp:v1', digest: 'sha256:00' }] };
    },
  },
});

const { startContainerImageImportJob } = await import('./containerImageImport.js');
const { readJob, whenJobEnds, countJobsThatMustFinish, cancelInterruptibleJobs } = await import('./jobs/index.js');

const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return log; } };

test('a received archive is imported as a job titled by its file name, without its path', async () => {
  const ack = await startContainerImageImportJob({
    stage: async (stagingPath) => {
      writeFileSync(stagingPath, 'archive');
      return 'C:\\builds\\myapp.tar';
    },
    log,
  });
  assert.equal(ack.kind, JOB_KIND.CONTAINER_IMAGE_IMPORT);
  assert.equal(ack.title, 'Import myapp.tar');
  assert.equal(ack.subject, null);
  assert.equal(await whenJobEnds(ack.jobId), 'done');
  assert.deepEqual(readJob(ack.jobId).result, { images: [{ name: 'localhost/myapp:v1', digest: 'sha256:00' }] });
  assert.match(imported.at(-1), /\.image-import-\d+\.tar$/);
});

test('an upload refused while it stages answers the error, with no job and no staging file', async () => {
  let stagingPath;
  await assert.rejects(
    startContainerImageImportJob({
      stage: async (p) => {
        stagingPath = p;
        writeFileSync(p, 'part of an archive');
        throw createAppError('UPLOAD_TOO_LARGE', 'File too large');
      },
      log,
    }),
    { code: 'UPLOAD_TOO_LARGE' },
  );
  assert.equal(existsSync(stagingPath), false);
});

test('an upload without a file name is titled as an image archive', async () => {
  const ack = await startContainerImageImportJob({
    stage: async (p) => { writeFileSync(p, 'archive'); return null; },
    log,
  });
  assert.equal(ack.title, 'Import image archive');
  await whenJobEnds(ack.jobId);
});

test('an import is a job that must finish: it counts against a self-update, and a shutdown does not cut it', async () => {
  const release = Promise.withResolvers();
  hold = release.promise;
  try {
    const ack = await startContainerImageImportJob({
      stage: async (p) => { writeFileSync(p, 'archive'); return 'myapp.tar'; },
      log,
    });
    assert.equal(countJobsThatMustFinish(), 1);
    await cancelInterruptibleJobs();
    assert.equal(readJob(ack.jobId).status, 'running');
    release.resolve();
    assert.equal(await whenJobEnds(ack.jobId), 'done');
  } finally {
    hold = null;
  }
});
