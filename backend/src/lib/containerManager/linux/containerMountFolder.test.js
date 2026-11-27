import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { emptyMountFolder } from './containerMountFolder.js';

const root = mkdtempSync(path.join(tmpdir(), 'wisp-mount-folder-test-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('a folder is emptied in place: the same folder, nothing in it, and nothing a link pointed at touched', async () => {
  const dir = path.join(root, 'site');
  const outside = path.join(root, 'outside');
  mkdirSync(path.join(dir, 'nested', 'deep'), { recursive: true });
  mkdirSync(path.join(dir, 'empty'));
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  writeFileSync(path.join(dir, 'old.html'), 'old');
  writeFileSync(path.join(dir, '.hidden'), 'h');
  writeFileSync(path.join(dir, 'nested', 'deep', 'f'), 'f');
  symlinkSync(outside, path.join(dir, 'link-to-folder'));
  symlinkSync(path.join(outside, 'keep.txt'), path.join(dir, 'link-to-file'));
  symlinkSync(path.join(root, 'nowhere'), path.join(dir, 'dangling'));
  const before = statSync(dir).ino;

  await emptyMountFolder(dir);

  assert.equal(statSync(dir).ino, before, 'the same folder');
  assert.deepEqual(readdirSync(dir), []);
  assert.deepEqual(readdirSync(outside), ['keep.txt']);
});

test('a missing folder is made, and a file or a link in its place is replaced by one', async () => {
  const missing = path.join(root, 'missing');
  await emptyMountFolder(missing);
  assert.ok(lstatSync(missing).isDirectory());

  const file = path.join(root, 'was-a-file');
  writeFileSync(file, 'x');
  await emptyMountFolder(file);
  assert.ok(lstatSync(file).isDirectory());

  const target = path.join(root, 'target');
  mkdirSync(target);
  writeFileSync(path.join(target, 'keep'), 'k');
  const link = path.join(root, 'was-a-link');
  symlinkSync(target, link);
  await emptyMountFolder(link);
  assert.ok(lstatSync(link).isDirectory());
  assert.ok(existsSync(path.join(target, 'keep')), 'the link\'s target is left alone');
});
