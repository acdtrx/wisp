/*
 * 0015 on a temporary runtime.env, with the ctx the runner builds: it removes
 * the retired CNI folder overrides and nothing else.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { run } from '../0015-retire-cni-dir-overrides.js';

let dir = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function context(text) {
  dir = mkdtempSync(path.join(tmpdir(), 'wisp-0015-test-'));
  const runtimeEnvFile = path.join(dir, 'runtime.env');
  if (text != null) writeFileSync(runtimeEnvFile, text, { mode: 0o600 });
  const changes = [];
  const unused = new Proxy({}, { get: (_t, key) => { throw new Error(`0015 reached the managers (${String(key)})`); } });
  return {
    file: runtimeEnvFile,
    changes,
    ctx: { vmManager: unused, containerManager: unused, paths: { runtimeEnvFile }, recordChange: (t) => changes.push(t) },
  };
}

test('the two overrides are removed, every other line kept, the mode kept', async () => {
  const { file, changes, ctx } = context([
    'WISP_PORT=8080',
    'WISP_CNI_BIN_DIR=/opt/cni/bin',
    '# WISP_CNI_CONF_DIR=',
    'export WISP_CNI_CONF_DIR=/etc/cni/net.d',
    'WISP_CONTAINERD_SOCK=/run/containerd/containerd.sock',
    'GITHUB_TOKEN=t',
    '',
  ].join('\n'));
  await run(ctx);
  assert.equal(readFileSync(file, 'utf8'), 'WISP_PORT=8080\n# WISP_CNI_CONF_DIR=\nWISP_CONTAINERD_SOCK=/run/containerd/containerd.sock\nGITHUB_TOKEN=t\n');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(changes.length, 2);
  assert.match(changes[0], /line 2: removed retired WISP_CNI_BIN_DIR/);
  assert.match(changes[1], /line 4: removed retired WISP_CNI_CONF_DIR/);
});

test('a file without them, or no file, is left alone', async () => {
  const { file, changes, ctx } = context('WISP_PORT=9000\n');
  await run(ctx);
  assert.equal(readFileSync(file, 'utf8'), 'WISP_PORT=9000\n');
  assert.deepEqual(changes, []);
  const none = context(null);
  await run(none.ctx);
  assert.deepEqual(none.changes, []);
});
