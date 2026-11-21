import { test } from 'node:test';
import assert from 'node:assert/strict';

import { defaultSshKeyName, parseSshKey, readSshKey, sshKeyFingerprint, validSshKeyName } from './sshKeys.js';

/* Throwaway keys made for these tests; their private halves were deleted. */
const ED = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOdeLqkpOO/B1Vr7+UA2R1RUQaJ6mBzBR3/Wgr9wnsEQ fixture@wisp';
const BARE = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINWHXLh4MaxFEqUXDv2aIrLAINjlt24qkbTyk63AO/k2';

test('a public key reads as its type, its identity and its comment, spaces made single', () => {
  const read = readSshKey(`  ${ED.replace(' fixture', '   fixture')}\n`);
  assert.equal(read.key, ED);
  assert.equal(read.type, 'ed25519');
  assert.equal(read.identity, ED.split(' ').slice(0, 2).join(' '));
  assert.equal(read.comment, 'fixture@wisp');
  // What `ssh-keygen -l` prints for it.
  assert.equal(sshKeyFingerprint(read), 'SHA256:08v9wPeCkNSKo9EepvUoAXugCkwFSCwf3lcjau08ZMw');
});

test('the same key with another comment is the same key', () => {
  assert.equal(readSshKey(`${BARE} laptop`).identity, readSshKey(BARE).identity);
  assert.notEqual(readSshKey(ED).identity, readSshKey(BARE).identity);
});

test('what is not one public key says why', () => {
  const problem = (text) => readSshKey(text).problem;
  assert.match(problem('-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn\n-----END OPENSSH PRIVATE KEY-----'), /private key/);
  assert.match(problem(`${ED}\n${BARE}`), /One key at a time/);
  assert.match(problem('ssh-dss AAAAB3NzaC1kc3M='), /not an SSH key type/);
  assert.match(problem('ssh-ed25519 not*base64'), /not base64/);
  // An RSA blob under the ed25519 name.
  assert.match(problem('ssh-ed25519 AAAAB3NzaC1yc2EAAAADAQAB'), /does not match its type/);
  assert.match(problem(''), /Paste an SSH public key/);
  assert.match(problem(`ssh-ed25519 ${'A'.repeat(9000)}`), /too long/);
  assert.throws(() => parseSshKey('nope'), (err) => err.code === 'SSH_KEY_INVALID');
});

test('a key without a name takes its comment, else one from its type', () => {
  assert.equal(defaultSshKeyName(readSshKey(ED)), 'fixture@wisp');
  assert.equal(defaultSshKeyName(readSshKey(BARE)), 'SSH key (ed25519)');
  assert.equal(validSshKeyName('  laptop '), 'laptop');
  assert.equal(validSshKeyName(' '), null);
  assert.equal(validSshKeyName('x'.repeat(65)), null);
  assert.equal(validSshKeyName('a\tb'), null);
});
