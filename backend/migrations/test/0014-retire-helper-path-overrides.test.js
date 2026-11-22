/*
 * 0014 on a temporary runtime.env, with the ctx the runner builds: it removes
 * the retired helper-path overrides and nothing else.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { run } from '../0014-retire-helper-path-overrides.js';

let dir = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function context(text) {
  dir = mkdtempSync(path.join(tmpdir(), 'wisp-0014-test-'));
  const runtimeEnvFile = path.join(dir, 'runtime.env');
  if (text != null) writeFileSync(runtimeEnvFile, text, { mode: 0o600 });
  const changes = [];
  const unused = new Proxy({}, { get: (_t, key) => { throw new Error(`0014 reached the managers (${String(key)})`); } });
  return {
    file: runtimeEnvFile,
    changes,
    ctx: { vmManager: unused, containerManager: unused, paths: { runtimeEnvFile }, recordChange: (t) => changes.push(t) },
  };
}

test('the five overrides are removed, every other line kept, the mode kept', async () => {
  const { file, changes, ctx } = context([
    'WISP_PORT=8080',
    'WISP_POWER_SCRIPT=/opt/x/wisp-power',
    '# WISP_SMARTCTL_SCRIPT=',
    'export WISP_NETNS_SCRIPT=/x',
    'WISP_DMIDECODE_SCRIPT=/x', 'WISP_SMARTCTL_SCRIPT=/x', 'WISP_CNI_SCRIPT=/x',
    'GITHUB_TOKEN=t',
    '',
  ].join('\n'));
  await run(ctx);
  assert.equal(readFileSync(file, 'utf8'), 'WISP_PORT=8080\n# WISP_SMARTCTL_SCRIPT=\nGITHUB_TOKEN=t\n');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(changes.length, 5);
  assert.match(changes[0], /line 2: removed retired WISP_POWER_SCRIPT/);
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
