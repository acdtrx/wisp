import { test } from 'node:test';
import assert from 'node:assert/strict';

import { defaultSshKeyName, parseSshKey, readSshKey, sshKeyFingerprint, validSshKeyName } from './sshKeys.js';

/*
 * Throwaway keys made for these tests (their private halves deleted), one of each type
 * Wisp takes, with what `ssh-keygen -l` printed for each. The two security-key ones
 * are built from the ed25519 and nistp256 keys' data with the application "ssh:"
 * (no hardware here); ssh-keygen read them too.
 */
const KEYS = [
  ['ed', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ7nqtDoMMcvu3Qpqnm0RakP0fFbshQ4943bs9P6sLvG ed@test', 'ed25519', 'SHA256:kXgahoApt4MUS91YrCS7A4xCOJuRMglWUvkwNSXcgk0'],
  ['rsa', 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDKtzJv8+TOqb4KdlLhY8xcFn28oCKjUNIztACbbaQmTKS++vYLqK7bwU7seYfkoDQAGRB2g1f3ZdPbEmC52nzFjiGwirRmtDAk6qnzYu5QrPNE0xEa4ZIvkNjenfGuoYszIpQbGex93GRxRAkdkpzu351gw1xOZaKTgn9Zas9qKLbM5Zy9P2R9bjIISh0ikUKoqzCpc+G+ZDlpohniinMhBGfvMAwM+rbnCImmJbg6VqQv3+XNsRDoLOb26unOCLXe4eqpaCHn6papl7x9AR5mxKlP92LrQBA3BUgbk7JVoiixDyviXpn/0gqRhuN9DRMIA0vVbSz7DXiOzf7kCTGL rsa@test', 'rsa', 'SHA256:4U5EphQToOjQhYjJtNdvN/PR+7gsbA+7z8yg0EbOkZw'],
  ['ec256', 'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBH1xVhlBTFHxIudqs3NXxtMy74dX+QkW2To2pk7pCr+hf1ATIrKWs2sjb0YpFnaGfwZxxv35hutAQ8pUDdnpyG0= ec256@test', 'ecdsa', 'SHA256:uFvjf09BvHggRZDnPjcaBNFUnurPYIJMFrJSHDp1z/I'],
  ['ec384', 'ecdsa-sha2-nistp384 AAAAE2VjZHNhLXNoYTItbmlzdHAzODQAAAAIbmlzdHAzODQAAABhBNAm5dlnAd8kGveZ2rhUqAPVDizYTFZPp6tyLL3jplf1uykjsmL7A3ga+w/yZnkpe7P7+gJseS/abDVy8olXqk5HilO6CPFEmoE8pej3Sunu9XVpohrc9ZlkSVxdjfxntQ== ec384@test', 'ecdsa', 'SHA256:RM0Syku27LC4rZWBnSwhQXj+5P6iAkS66weL/Kw7m5s'],
  ['ec521', 'ecdsa-sha2-nistp521 AAAAE2VjZHNhLXNoYTItbmlzdHA1MjEAAAAIbmlzdHA1MjEAAACFBAG4J1FaqP25pVa+iw32k9+j3B5mFOLVhKPruO0rK1QLDM47aILxSEPcoa0pO/tbwl61dv2snKQg9gPUBVMPGdtKYAA9Kao2vFwmmraqQzTf6+2hvgJeP9egm/jxsCsw87f0BEYIhB48186kDp/kP0lae3yXeCGq/RdKMWDTmpJWU4Ti3w== ec521@test', 'ecdsa', 'SHA256:NBXsT4Me9cs5xl/EZVzMZuC5H6exw9nb9d0hhTffC7M'],
  ['sk1', 'sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29tAAAAIJ7nqtDoMMcvu3Qpqnm0RakP0fFbshQ4943bs9P6sLvGAAAABHNzaDo= sk1@test', 'ed25519-sk', 'SHA256:82meLZPDF338M8me2bjt4scre5oQqkiE/+smF5yMO34'],
  ['sk2', 'sk-ecdsa-sha2-nistp256@openssh.com AAAAInNrLWVjZHNhLXNoYTItbmlzdHAyNTZAb3BlbnNzaC5jb20AAAAIbmlzdHAyNTYAAABBBH1xVhlBTFHxIudqs3NXxtMy74dX+QkW2To2pk7pCr+hf1ATIrKWs2sjb0YpFnaGfwZxxv35hutAQ8pUDdnpyG0AAAAEc3NoOg== sk2@test', 'ecdsa-sk', 'SHA256:/WY9dMFV6imCwnWk8dshWMk4HfLngCaN7y4rgvDToe4'],
];
const ED = KEYS[0][1];
const RSA = KEYS[1][1];
const [, ED_DATA] = ED.split(' ');

/** The blob as base64 with `change` applied to its bytes. */
const reblob = (key, change) => {
  const [type, data] = key.split(' ');
  return `${type} ${change(Buffer.from(data, 'base64')).toString('base64')}`;
};

test('a key of each type Wisp takes reads whole, with its type and the fingerprint ssh-keygen prints', () => {
  for (const [label, key, type, fingerprint] of KEYS) {
    const read = readSshKey(key);
    assert.equal(read.problem, undefined, label);
    assert.equal(read.key, key, label);
    assert.equal(read.type, type, label);
    assert.equal(sshKeyFingerprint(read), fingerprint, label);
  }
});

test('spaces are made single; the same key with another comment is the same key', () => {
  const read = readSshKey(`  ${ED.replace(' ed@test', '   ed@test')}  `);
  assert.equal(read.key, ED);
  assert.equal(read.comment, 'ed@test');
  assert.equal(readSshKey(`ssh-ed25519 ${ED_DATA} laptop`).identity, read.identity);
  assert.notEqual(readSshKey(RSA).identity, read.identity);
});

test('a key that is not whole is refused', () => {
  const problem = (text) => readSshKey(text).problem;
  // The type's header alone, with no key data.
  assert.match(problem(reblob(ED, (b) => b.subarray(0, 4 + 11))), /not a whole key/);
  // Its base64 cut short, at a 4-character boundary and inside one.
  assert.match(problem(`ssh-ed25519 ${ED_DATA.slice(0, 40)}`), /not a whole key/);
  assert.match(problem(`ssh-ed25519 ${ED_DATA.slice(0, 41)}`), /cut short/);
  // Bytes after the last field.
  assert.match(problem(reblob(ED, (b) => Buffer.concat([b, Buffer.from('junk')]))), /not a whole key/);
  assert.match(problem(reblob(RSA, (b) => Buffer.concat([b, Buffer.alloc(4)]))), /not a whole key/);
  // A field of the wrong size: a 31-byte ed25519 key.
  assert.match(problem(reblob(ED, (b) => { const c = Buffer.from(b.subarray(0, b.length - 1)); c.writeUInt32BE(31, 15); return c; })), /not a whole key/);
  // An ECDSA key naming another curve than its type.
  assert.match(problem(KEYS[2][1].replace('ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384').split(' ').slice(0, 2).join(' ')), /not a whole key/);
  // A blob of another type under this type's name.
  assert.match(problem(`ssh-ed25519 ${RSA.split(' ')[1]}`), /not a whole key/);
});

test('one text per key: base64 that is not canonical is refused', () => {
  // An ECDSA key's data ends in one "=": its last character has two unused bits. Set
  // them, and it decodes to the same key under another text.
  const [type, data] = KEYS[2][1].split(' ');
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const last = data.at(-2);
  const twin = `${data.slice(0, -2)}${ALPHABET[ALPHABET.indexOf(last) + 1]}=`;
  assert.deepEqual(Buffer.from(twin, 'base64'), Buffer.from(data, 'base64'));
  assert.match(readSshKey(`${type} ${twin}`).problem, /not plain base64/);
  // Padding where none belongs.
  assert.match(readSshKey(`ssh-ed25519 ${ED_DATA}==`).problem, /not plain base64/);
});

test('one key at a time: a wrapped paste or two keys on a line are refused', () => {
  const problem = (text) => readSshKey(text).problem;
  assert.match(problem(`${ED}\n${RSA}`), /One key at a time/);
  // Two keys made one line (as the picker's field makes a pasted pair).
  assert.match(problem(`${ED} ${RSA}`), /One key at a time/);
  assert.match(problem(`ssh-ed25519 ${ED_DATA} ${RSA}`), /One key at a time/);
  // A wrapped paste: the rest of the data would become the comment.
  assert.match(problem(`ssh-rsa ${RSA.split(' ')[1].slice(0, 200)} ${RSA.split(' ')[1].slice(200)}`), /cut short|not a whole key/);
});

test('what is no public key at all says why', () => {
  const problem = (text) => readSshKey(text).problem;
  assert.match(problem('-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn\n-----END OPENSSH PRIVATE KEY-----'), /private key/);
  assert.match(problem('ssh-dss AAAAB3NzaC1kc3M='), /not an SSH key type/);
  assert.match(problem('ssh-ed25519 not*base64'), /not base64/);
  assert.match(problem(''), /Paste an SSH public key/);
  assert.match(problem(`ssh-ed25519 ${'A'.repeat(9000)}`), /too long/);
  assert.throws(() => parseSshKey('nope'), (err) => err.code === 'SSH_KEY_INVALID');
});

test('a key without a name takes its comment, else one from its type', () => {
  assert.equal(defaultSshKeyName(readSshKey(ED)), 'ed@test');
  assert.equal(defaultSshKeyName(readSshKey(`ssh-ed25519 ${ED_DATA}`)), 'SSH key (ed25519)');
  assert.equal(validSshKeyName('  laptop '), 'laptop');
  assert.equal(validSshKeyName(' '), null);
  assert.equal(validSshKeyName('x'.repeat(65)), null);
  assert.equal(validSshKeyName('a\tb'), null);
});
