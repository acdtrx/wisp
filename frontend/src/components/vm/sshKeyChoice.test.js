import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultKeys, keyIdentity, keysText, listedKey, otherKeyName, otherKeys, picks, sshKeyText, tidyKey, toggled, vmKeyLines,
} from './sshKeyChoice.js';

const LIST = [
  { id: 'a', name: 'laptop', key: 'ssh-ed25519 AAAA1 me@laptop', default: true },
  { id: 'b', name: 'octo on GitHub', key: 'ssh-rsa BBBB2', default: false },
  { id: 'c', name: 'desk', key: 'ssh-ed25519 CCCC3 me@desk', default: true },
];

test('a key is the list’s by its type and data, whatever its comment', () => {
  assert.equal(keyIdentity('  ssh-rsa BBBB2  old-comment '), 'ssh-rsa BBBB2');
  assert.equal(listedKey(LIST, 'ssh-rsa BBBB2 from-the-vm').id, 'b');
  assert.equal(listedKey(LIST, 'ssh-rsa ZZZZ'), null);
  assert.equal(keyIdentity('nonsense'), null);
  assert.equal(tidyKey('  ssh-ed25519   AAAA1\tme@laptop \n'), 'ssh-ed25519 AAAA1 me@laptop');
});

test('the page names a VM’s keys by the list’s names, and counts the others', () => {
  assert.equal(keysText('ssh-rsa BBBB2 x\nssh-ed25519 AAAA1 me@laptop', LIST), 'octo on GitHub, laptop');
  assert.equal(keysText('ssh-ed25519 AAAA1\nssh-ed25519 OTHER1 a\n\nssh-rsa OTHER2', LIST), 'laptop, 2 other keys');
  assert.equal(keysText('ssh-ed25519 OTHER1 a', LIST), '1 other key');
  assert.equal(keysText('', LIST), 'None');
});

test('a new setup starts from the default keys; the choice goes out in the list’s order, the others after', () => {
  assert.deepEqual(defaultKeys(LIST), ['ssh-ed25519 AAAA1 me@laptop', 'ssh-ed25519 CCCC3 me@desk']);
  const chosen = ['ssh-ed25519 OWN1 vm-only', 'ssh-ed25519 CCCC3 me@desk', 'ssh-rsa BBBB2 vm-comment'];
  assert.equal(sshKeyText(chosen, LIST), 'ssh-rsa BBBB2 vm-comment\nssh-ed25519 CCCC3 me@desk\nssh-ed25519 OWN1 vm-only');
});

test('picking and unpicking by identity; the VM’s own keys outside the list stay shown', () => {
  let chosen = vmKeyLines('ssh-rsa BBBB2 vm-comment\nssh-ed25519 OWN1 vm-only\n');
  assert.equal(picks(chosen, 'ssh-rsa BBBB2'), true);
  chosen = toggled(chosen, 'ssh-ed25519 OWN1 vm-only', false);
  assert.deepEqual(chosen, ['ssh-rsa BBBB2 vm-comment']);
  assert.deepEqual(otherKeys(LIST, ['ssh-ed25519 OWN1 vm-only', 'ssh-rsa BBBB2 x'], chosen), ['ssh-ed25519 OWN1 vm-only']);
  assert.deepEqual(toggled(chosen, 'ssh-rsa BBBB2', true), ['ssh-rsa BBBB2']);
  assert.equal(otherKeyName('ssh-ed25519 OWN1 vm only'), 'vm only');
  assert.equal(otherKeyName('ssh-ed25519 OWN1'), 'A key not in Wisp’s list');
});
