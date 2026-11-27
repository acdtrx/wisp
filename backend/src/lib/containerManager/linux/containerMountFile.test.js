import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { writeMountFileInPlace } from './containerMountFile.js';

const root = mkdtempSync(path.join(tmpdir(), 'wisp-mount-file-test-'));
after(() => rmSync(root, { recursive: true, force: true }));

const staged = (name, content) => {
  const p = path.join(root, name);
  writeFileSync(p, content);
  return { fromPath: p };
};

test('an upload replaces the content in the same file, with no tail of a longer old content', async () => {
  const dest = path.join(root, 'app.conf');
  writeFileSync(dest, 'a much longer old content, line after line\n'.repeat(100), { mode: 0o640 });
  const inode = statSync(dest).ino;
  const answer = await writeMountFileInPlace(dest, staged('up-1', 'listen 8080\n'), undefined);
  assert.equal(statSync(dest).ino, inode, 'the same file');
  assert.equal(readFileSync(dest, 'utf8'), 'listen 8080\n');
  assert.equal(answer.size, 12);
  assert.equal(typeof answer.modified, 'string');
  assert.equal(statSync(dest).mode & 0o777, 0o640, 'a plain file keeps its mode');
});

test('an editor save writes in place too, and a secret mount\'s mode is put on before the content', async () => {
  const dest = path.join(root, 'secret');
  writeFileSync(dest, 'old secret', { mode: 0o644 });
  const inode = statSync(dest).ino;
  await writeMountFileInPlace(dest, new TextEncoder().encode('new'), 0o600);
  assert.equal(statSync(dest).ino, inode);
  assert.equal(readFileSync(dest, 'utf8'), 'new');
  assert.equal(statSync(dest).mode & 0o777, 0o600);
  await writeMountFileInPlace(dest, new Uint8Array(0), 0o600);
  assert.equal(statSync(dest).size, 0, 'an empty save empties it');
});

test('a missing file is made, at the mode given or 0666 under the umask', async () => {
  const secret = path.join(root, 'new-secret');
  await writeMountFileInPlace(secret, staged('up-2', 'k'), 0o600);
  assert.equal(statSync(secret).mode & 0o777, 0o600);
  const plain = path.join(root, 'new-plain');
  await writeMountFileInPlace(plain, staged('up-3', 'p'), undefined);
  assert.equal(statSync(plain).mode & 0o777, 0o666 & ~process.umask());
  assert.equal(readFileSync(plain, 'utf8'), 'p');
});

test('a symbolic link at the file is replaced by a file, never followed', async () => {
  const outside = path.join(root, 'outside.txt');
  writeFileSync(outside, 'host file');
  const dest = path.join(root, 'linked');
  symlinkSync(outside, dest);
  await writeMountFileInPlace(dest, staged('up-4', 'mine'), undefined);
  assert.ok(lstatSync(dest).isFile());
  assert.equal(readFileSync(dest, 'utf8'), 'mine');
  assert.equal(readFileSync(outside, 'utf8'), 'host file');
});

test('a copy that fails leaves no file beside the destination and answers the error', async () => {
  const dir = mkdtempSync(path.join(root, 'fail-'));
  const dest = path.join(dir, 'conf');
  writeFileSync(dest, 'old');
  await assert.rejects(writeMountFileInPlace(dest, { fromPath: path.join(dir, 'no-such-upload') }, undefined), { code: 'ENOENT' });
  assert.deepEqual(readdirSync(dir), ['conf']);
});
