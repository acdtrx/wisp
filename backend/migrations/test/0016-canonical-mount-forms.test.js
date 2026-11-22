/*
 * 0016 on a temporary wisp-config.json, with the ctx the runner builds: mount
 * paths and shares brought to their forms, a share that cannot be left and
 * reported, everything else kept.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { run } from '../0016-canonical-mount-forms.js';

let dir = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function context(data) {
  dir = mkdtempSync(path.join(tmpdir(), 'wisp-0016-test-'));
  const configFile = path.join(dir, 'wisp-config.json');
  if (data !== undefined) writeFileSync(configFile, typeof data === 'string' ? data : JSON.stringify(data), { mode: 0o600 });
  const changes = [];
  const unused = new Proxy({}, { get: (_t, key) => { throw new Error(`0016 reached the managers (${String(key)})`); } });
  return {
    file: configFile,
    changes,
    ctx: { vmManager: unused, containerManager: unused, paths: { configFile }, recordChange: (t) => changes.push(t) },
  };
}

test('mount paths and shares are brought to their forms; the rest is kept', async () => {
  const { file, changes, ctx } = context({
    serverName: 'box',
    mounts: [
      { id: 'a', type: 'smb', label: 'NAS', mountPath: '/mnt/wisp/nas/', share: '\\\\nas\\media\\', username: 'u', password: 'p' },
      { id: 'b', type: 'disk', label: 'USB', mountPath: '/mnt/wisp//usb', uuid: 'abcd-1234', fsType: 'exfat' },
      { id: 'c', type: 'smb', label: 'Ok', mountPath: '/mnt/wisp/ok', share: '//nas/ok' },
    ],
  });
  await run(ctx);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(data.serverName, 'box');
  assert.deepEqual(data.mounts, [
    { id: 'a', type: 'smb', label: 'NAS', mountPath: '/mnt/wisp/nas', share: '//nas/media', username: 'u', password: 'p' },
    { id: 'b', type: 'disk', label: 'USB', mountPath: '/mnt/wisp/usb', uuid: 'abcd-1234', fsType: 'exfat' },
    { id: 'c', type: 'smb', label: 'Ok', mountPath: '/mnt/wisp/ok', share: '//nas/ok' },
  ]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(changes, [
    'wisp-config.json: mount "a" ("NAS"): mountPath "/mnt/wisp/nas/" → "/mnt/wisp/nas"',
    'wisp-config.json: mount "a" ("NAS"): share "\\\\\\\\nas\\\\media\\\\" → "//nas/media"',
    'wisp-config.json: mount "b" ("USB"): mountPath "/mnt/wisp//usb" → "/mnt/wisp/usb"',
  ]);
});

test('a share that cannot be brought into form is left and reported', async () => {
  const mounts = [{ id: 'x', type: 'smb', label: 'Bad', mountPath: '/mnt/wisp/bad', share: '//nas' }];
  const { file, changes, ctx } = context({ mounts });
  const before = readFileSync(file, 'utf8');
  await run(ctx);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(changes.length, 1);
  assert.match(changes[0], /mount "x" \("Bad"\): share "\/\/nas" left as it is/);
});

test('mounts in form, no mounts, no file or no JSON are left alone', async () => {
  for (const data of [{ mounts: [{ id: 'c', type: 'smb', mountPath: '/mnt/wisp/ok', share: '//nas/ok' }] }, { serverName: 'x' }, undefined, '{oops']) {
    const { file, changes, ctx } = context(data);
    const before = data === undefined ? null : readFileSync(file, 'utf8');
    await run(ctx);
    assert.deepEqual(changes, []);
    if (before !== null) assert.equal(readFileSync(file, 'utf8'), before);
  }
});
