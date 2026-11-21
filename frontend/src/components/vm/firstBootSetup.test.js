import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extrasText, keyText, setupForm, setupProblem, setupSent, storedSetup } from './firstBootSetup.js';

const stored = {
  enabled: true, hostname: 'archy', username: 'alex', password: 'set', sshKey: 'ssh-ed25519 AAAA alex@laptop',
  sshKeySource: 'manual', growPartition: true, packageUpgrade: false, installQemuGuestAgent: true, installAvahiDaemon: false,
};

test('the read placeholder is no setup; a soft-disabled one is a setup', () => {
  assert.equal(storedSetup({ enabled: false }), null);
  assert.equal(storedSetup(null), null);
  assert.ok(storedSetup({ ...stored, enabled: false }));
});

test('Save turns the setup on, keeps a stored password unless one is typed', () => {
  const form = setupForm(stored);
  assert.equal(form.password, '');
  const sent = setupSent(form, stored, 'archy');
  assert.equal(sent.enabled, true);
  assert.equal(sent.password, 'set');
  assert.equal(setupSent({ ...form, password: 'new' }, stored, 'archy').password, 'new');
  assert.equal(setupSent(setupForm(null), null, 'vm1').password, '');
});

test('an empty host name is the VM name; an emptied key has no source', () => {
  const form = { ...setupForm(stored), hostname: '  ', sshKey: '' };
  const sent = setupSent(form, stored, 'renamed');
  assert.equal(sent.hostname, 'renamed');
  assert.equal(sent.sshKeySource, '');
  assert.equal(setupSent({ ...setupForm(null), sshKey: 'ssh-rsa AAA x' }, null, 'v').sshKeySource, 'manual');
});

test('a new setup starts from the defaults and needs a valid user', () => {
  const form = setupForm(null);
  assert.equal(form.username, 'wisp');
  assert.equal(form.growPartition, true);
  assert.equal(setupProblem(form, 'vm1'), null);
  assert.ok(setupProblem({ ...form, username: 'Alex' }, 'vm1'));
  assert.ok(setupProblem({ ...form, username: '' }, 'vm1'));
  assert.match(setupProblem(form, 'my.vm'), /no host name/);
  assert.equal(setupProblem({ ...form, hostname: 'my-vm' }, 'my.vm'), null);
});

test('the page names the key and the extras', () => {
  assert.equal(keyText(stored), 'alex@laptop');
  assert.equal(keyText({ sshKey: 'ssh-rsa AAA', sshKeySource: 'github:alex' }), 'From GitHub (alex)');
  assert.equal(keyText({ sshKey: '' }), 'None');
  assert.equal(extrasText(stored), 'grows the disk, installs the guest agent');
});
