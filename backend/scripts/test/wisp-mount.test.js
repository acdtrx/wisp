import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { helperBench } from './helperHarness.js';

const bench = helperBench();
after(() => bench.cleanup());

const SHARE = '//nas/media';
const POINT = '/mnt/wisp/smb-nas';
const UUID = '0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0';
const creds = path.join(bench.dir, 'credentials');
writeFileSync(creds, 'username=u\npassword=\n', { mode: 0o600 });

test('wisp-mount refuses each wrong argument before it runs anything', () => {
  const wrong = [
    [],
    ['unmount'],
    ['smb', 'mount', '/tmp/smb.conf'],
    ['smb-mount', SHARE, POINT, 'guest'],
    ['smb-mount', SHARE, POINT, 'guest', 'shared', 'x'],
    ['smb-check', SHARE, POINT, 'guest', 'shared'],
    ['disk-mount', UUID, POINT, 'ext4'],
    ['unmount', POINT, '-l'],
    // the share
    ['smb-mount', '-o', POINT, 'guest', 'shared'],
    ['smb-mount', '-oexec//nas/x', POINT, 'guest', 'shared'],
    ['smb-mount', 'nas/media', POINT, 'guest', 'shared'],
    ['smb-mount', '//nas', POINT, 'guest', 'shared'],
    ['smb-mount', '//nas/media,suid', POINT, 'guest', 'shared'],
    ['smb-mount', '//na s/media', POINT, 'guest', 'shared'],
    ['smb-mount', '//nas/me\ndia', POINT, 'guest', 'shared'],
    // the mount path
    ['smb-mount', SHARE, '/mnt/wisp', 'guest', 'shared'],
    ['smb-mount', SHARE, '/mnt/wisp/', 'guest', 'shared'],
    ['smb-mount', SHARE, '/mnt/wisp/../../etc', 'guest', 'shared'],
    ['smb-mount', SHARE, '/mnt/wisp//x', 'guest', 'shared'],
    ['smb-mount', SHARE, '/etc', 'guest', 'shared'],
    ['smb-mount', SHARE, 'mnt/wisp/x', 'guest', 'shared'],
    ['smb-mount', SHARE, '/mnt/wispx/y', 'guest', 'shared'],
    // the credentials and the mode
    ['smb-mount', SHARE, POINT, 'relative/creds', 'shared'],
    ['smb-mount', SHARE, POINT, `${creds},suid`, 'shared'],
    ['smb-mount', SHARE, POINT, '/nonexistent/credentials', 'shared'],
    ['smb-mount', SHARE, POINT, 'guest', 'suid'],
    ['smb-mount', SHARE, POINT, 'guest', ''],
    // a disk
    ['disk-mount', '../../sda1', POINT, 'ext4', 'rw'],
    ['disk-mount', '-sda1', POINT, 'ext4', 'rw'],
    ['disk-mount', `${UUID},suid`, POINT, 'ext4', 'rw'],
    ['disk-mount', UUID, POINT, 'xfs', 'rw'],
    ['disk-mount', UUID, POINT, 'ext4', 'suid'],
    ['disk-mount', UUID, '/media/x', 'ext4', 'rw'],
    // unmount and rmdir
    ['unmount', '/'],
    ['unmount', '/mnt/wisp/x/'],
    ['unmount-lazy', '/mnt/wisp/./x'],
    ['rmdir', '/mnt/wisp'],
    ['rmdir', '/home/x'],
  ];
  for (const args of wrong) bench.assertRefused('wisp-mount', args);
});

test('a credentials file of another user is refused', () => {
  const r = bench.run('wisp-mount', ['smb-mount', SHARE, POINT, creds, 'shared'], {
    env: { SUDO_UID: '4242', SUDO_GID: '4242' },
    standIns: { stat: `echo ${process.getuid()}` },
  });
  assert.equal(r.code, 64, r.stderr);
  assert.match(r.stderr, /^wisp-mount: the credentials file must be the invoking user's \(uid 4242\)/);
});

test('a disk that is not there is exit 2, before anything runs', () => {
  const r = bench.run('wisp-mount', ['disk-mount', UUID, POINT, 'ext4', 'rw']);
  assert.equal(r.code, 2, r.stderr);
  assert.equal(r.stderr, `wisp-mount: no disk with UUID ${UUID}\n`);
  assert.deepEqual(r.calls, []);
});
