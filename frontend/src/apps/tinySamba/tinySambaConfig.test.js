import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  editDeletesShareData, removalDeletesShareData, sambaSendable, serverForm, serverProblems, shareForm, shareProblem,
  sharesOnlyUserReaches, userProblem, withServer, withShare, withUser, withoutShare, withoutUser,
} from './tinySambaConfig.js';

const stored = {
  server: { workgroup: 'WORKGROUP', netbiosName: 'samba', dataUid: 1000, minProtocol: 'SMB3', iconModel: 'TimeCapsule6,106' },
  users: [{ name: 'alice', password: { isSet: true } }, { name: 'bob', password: { isSet: true } }],
  shares: [
    { name: 'docs', guest: false, source: null, access: [{ user: 'alice', level: 'rw' }, { user: 'bob', level: 'ro' }] },
    { name: 'archive', guest: false, source: { sourceId: 'usb', subPath: 'a' }, access: [{ user: 'alice', level: 'rw' }] },
    { name: 'public', guest: true, source: null, access: [] },
  ],
};

test('users go by name alone, which keeps their passwords; every saved share names itself', () => {
  const sent = sambaSendable(stored);
  assert.deepEqual(sent.users, [{ name: 'alice' }, { name: 'bob' }]);
  assert.deepEqual(sent.shares.map((s) => s.previousName), ['docs', 'archive', 'public']);
  assert.deepEqual(sent.shares[1].source, { sourceId: 'usb', subPath: 'a' });
  assert.equal('source' in sent.shares[0], false);
});

test('a share renamed sends its stored name, a new one none', () => {
  const renamed = withShare(stored, 'docs', { ...shareForm(stored.shares[0]), name: 'papers' });
  assert.deepEqual(renamed.shares[0], {
    name: 'papers', previousName: 'docs', guest: false, access: [{ user: 'alice', level: 'rw' }, { user: 'bob', level: 'ro' }],
  });
  const added = withShare(stored, null, { ...shareForm(null), name: 'new', access: { bob: 'rw' } });
  assert.deepEqual(added.shares.at(-1), { name: 'new', guest: false, access: [{ user: 'bob', level: 'rw' }] });
  assert.deepEqual(withoutShare(stored, 'docs').shares.map((s) => s.name), ['archive', 'public']);
});

test('removing a local share deletes its data; a storage share keeps it', () => {
  assert.equal(removalDeletesShareData(stored, 'docs'), true);
  assert.equal(removalDeletesShareData(stored, 'archive'), false);
  assert.equal(editDeletesShareData(stored, 'docs', { ...shareForm(stored.shares[0]), sourceId: 'usb' }), true);
  assert.equal(editDeletesShareData(stored, 'docs', { ...shareForm(stored.shares[0]), name: 'renamed' }), false);
  assert.equal(editDeletesShareData(stored, null, { ...shareForm(null), sourceId: 'usb' }), false);
});

test('a share needs a free name and a user with access, unless it is a guest share', () => {
  assert.equal(shareProblem(stored, null, { ...shareForm(null), name: 'docs', guest: true }), 'docs is a share already.');
  assert.ok(shareProblem(stored, null, { ...shareForm(null), name: 'x' }));
  assert.equal(shareProblem(stored, null, { ...shareForm(null), name: 'x', guest: true }), null);
  assert.equal(shareProblem(stored, 'docs', shareForm(stored.shares[0])), null);
});

test('a user renamed follows into the shares; removed, it leaves them', () => {
  const renamed = withUser(stored, 'bob', { name: 'robert', password: 'pw' });
  assert.deepEqual(renamed.users[1], { name: 'robert', password: 'pw' });
  assert.deepEqual(renamed.shares[0].access[1], { user: 'robert', level: 'ro' });
  assert.deepEqual(withoutUser(stored, 'bob').shares[0].access, [{ user: 'alice', level: 'rw' }]);
  assert.deepEqual(sharesOnlyUserReaches(stored, 'alice'), ['archive']);
});

test('a new or renamed user needs a password', () => {
  assert.equal(userProblem(stored, null, { name: 'carol', password: '' }), 'A new user needs a password.');
  assert.equal(userProblem(stored, 'bob', { name: 'bob', password: '' }), null);
  assert.equal(userProblem(stored, 'bob', { name: 'alice', password: 'x' }), 'alice is a user already.');
  assert.ok(userProblem(stored, null, { name: 'Carol', password: 'x' }));
});

test('the server form keeps the users and shares, and checks its fields', () => {
  const form = serverForm(stored);
  assert.equal(form.dataUid, '1000');
  const sent = withServer(stored, { ...form, minProtocol: 'SMB2' });
  assert.equal(sent.server.minProtocol, 'SMB2');
  assert.equal(sent.server.dataUid, 1000);
  assert.deepEqual(sent.users, [{ name: 'alice' }, { name: 'bob' }]);
  assert.deepEqual(Object.keys(serverProblems({ ...form, dataUid: '70000', workgroup: '' })), ['workgroup', 'dataUid']);
});
