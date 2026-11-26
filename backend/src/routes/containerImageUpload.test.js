/*
 * The image archive upload's answers before any import (docs/specs/API-CONTAINERS.md →
 * POST /api/containers/images/upload): its scope, and the multipart answers it shares
 * with the mount uploads. lib/containerImageImport.js is mocked (node --test
 * --experimental-test-module-mocks): the stand-in stages the upload as the real one
 * does, into a file of its own, and answers a job's ack.
 */
import { after, before, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Fastify from 'fastify';

import { JOB_KIND } from '../../../shared/wireNames.js';

const AGENT_TOKEN = 'wisp_agent_upload-test-agent-token';
const READ_TOKEN = 'wisp_read_upload-test-read-token';

const dir = mkdtempSync(path.join(tmpdir(), 'wisp-image-upload-test-'));
const tokenEntry = (id, scope, token) => ({
  id, label: id, scope, tokenHash: createHash('sha256').update(token).digest('hex'), createdAt: '2026-01-01T00:00:00.000Z',
});
writeFileSync(path.join(dir, 'wisp-config.json'), JSON.stringify({
  apiTokens: [tokenEntry('agent', 'agent', AGENT_TOKEN), tokenEntry('read', 'read', READ_TOKEN)],
}));
// config.js reads the path when it loads: set it before the app is imported.
process.env.WISP_CONFIG_PATH = path.join(dir, 'wisp-config.json');

/** Each call of the stand-in: the file it staged (null when staging refused) and the name the client sent. */
const imports = [];
let staged = 0;
mock.module(new URL('../lib/containerImageImport.js', import.meta.url).href, {
  exports: {
    startContainerImageImportJob: async ({ stage }) => {
      const stagingPath = path.join(dir, `staged-${staged += 1}`);
      const call = { stagingPath, fileName: null, content: null };
      imports.push(call);
      try {
        call.fileName = await stage(stagingPath);
      } finally {
        call.content = existsSync(stagingPath) ? readFileSync(stagingPath, 'utf8') : null;
        rmSync(stagingPath, { force: true });
      }
      return { jobId: 'job-1', kind: JOB_KIND.CONTAINER_IMAGE_IMPORT, title: `Import ${call.fileName}`, subject: null };
    },
  },
});

let app;

before(async () => {
  const { buildApp } = await import('../app.js');
  ({ app } = await buildApp(Fastify({ logger: { level: 'silent' } }).log));
});

after(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

const BOUNDARY = 'wisp-test-boundary';

/** A multipart body of `parts`: `{ name, value }` fields and `{ name, filename, value }` files. */
function multipart(parts) {
  const chunks = parts.map((p) => [
    `--${BOUNDARY}\r\n`,
    p.filename
      ? `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\nContent-Type: application/x-tar\r\n\r\n`
      : `Content-Disposition: form-data; name="${p.name}"\r\n\r\n`,
    p.value,
    '\r\n',
  ].join(''));
  return `${chunks.join('')}--${BOUNDARY}--\r\n`;
}

function upload(parts, token = AGENT_TOKEN) {
  return app.inject({
    method: 'POST',
    url: '/api/containers/images/upload',
    headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    payload: multipart(parts),
  });
}

test('an agent token\'s upload of one file is staged whole and answers the import job\'s ack', async () => {
  imports.length = 0;
  const res = await upload([
    { name: 'note', value: 'a field is ignored' },
    { name: 'file', filename: 'myapp.tar', value: 'archive bytes' },
  ]);
  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.json(), { jobId: 'job-1', kind: JOB_KIND.CONTAINER_IMAGE_IMPORT, title: 'Import myapp.tar', subject: null });
  assert.equal(imports.length, 1);
  assert.equal(imports[0].fileName, 'myapp.tar');
  assert.equal(imports[0].content, 'archive bytes');
});

test('a read token\'s upload answers 403 SCOPE_INSUFFICIENT, and nothing is staged', async () => {
  imports.length = 0;
  const res = await upload([{ name: 'file', filename: 'myapp.tar', value: 'archive bytes' }], READ_TOKEN);
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'SCOPE_INSUFFICIENT');
  assert.equal(imports.length, 0);
});

test('an upload without a file part answers 400 UPLOAD_NO_FILE', async () => {
  imports.length = 0;
  const res = await upload([{ name: 'note', value: 'no file here' }]);
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'UPLOAD_NO_FILE');
  assert.equal(imports.length, 1);
  assert.equal(imports[0].fileName, null, 'the staging refused: no job');
});

test('an upload with two file parts answers 400 BAD_MULTIPART_TOO_MANY_FILES', async () => {
  imports.length = 0;
  const res = await upload([
    { name: 'file', filename: 'one.tar', value: 'first' },
    { name: 'file', filename: 'two.tar', value: 'second' },
  ]);
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'BAD_MULTIPART_TOO_MANY_FILES');
  assert.equal(imports[0].fileName, null, 'the staging refused: no job');
});
