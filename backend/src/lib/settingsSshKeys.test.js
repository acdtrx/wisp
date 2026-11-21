/*
 * Wisp's SSH keys in the settings file, on a temporary one (WISP_CONFIG_PATH, set
 * before the settings module loads): the writes, what the read shows, and what the
 * strict read refuses.
 */
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'wisp-ssh-keys-test-'));
const file = path.join(dir, 'wisp-config.json');
process.env.WISP_CONFIG_PATH = file;

const settings = await import('./settings.js');
const { parseWispConfig } = await import('./configSchema.js');

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => writeFileSync(file, '{}\n'));

/* Throwaway keys made for these tests; their private halves were deleted. */
const ED = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOdeLqkpOO/B1Vr7+UA2R1RUQaJ6mBzBR3/Wgr9wnsEQ fixture@wisp';
const BARE = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINWHXLh4MaxFEqUXDv2aIrLAINjlt24qkbTyk63AO/k2';
const ONE = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIP2C1hlFBe9QML3bRE1Gh3BJUVZH5PFKHL4zAiVmsjfs wp-one@scratch';

const stored = () => JSON.parse(readFileSync(file, 'utf8')).sshKeys;

test('an added key is stored, not a default, named by its comment, and read with its type and fingerprint', async () => {
  const { id } = await settings.addSshKey({ key: ED });
  assert.deepEqual(stored(), [{ id, name: 'fixture@wisp', key: ED, default: false }]);
  assert.deepEqual((await settings.getSettings()).sshKeys, [
    { id, name: 'fixture@wisp', key: ED, default: false, type: 'ed25519', fingerprint: 'SHA256:08v9wPeCkNSKo9EepvUoAXugCkwFSCwf3lcjau08ZMw' },
  ]);
  const named = await settings.addSshKey({ key: BARE, name: ' laptop ' });
  assert.equal(stored().find((k) => k.id === named.id).name, 'laptop');
});

test('the same key twice is refused, naming the one listed', async () => {
  await settings.addSshKey({ key: BARE, name: 'laptop' });
  await assert.rejects(settings.addSshKey({ key: `${BARE} other-comment` }), (err) => err.code === 'SSH_KEY_DUPLICATE' && /"laptop"/.test(err.message));
  await assert.rejects(settings.addSshKey({ key: 'ssh-ed25519 nope' }), (err) => err.code === 'SSH_KEY_INVALID');
  assert.equal(stored().length, 1);
});

test('a GitHub import adds the new keys under generic names and counts those already listed', async () => {
  await settings.addSshKey({ key: ED });
  const result = await settings.importSshKeys('octo', [ED.split(' ').slice(0, 2).join(' '), BARE, ONE.split(' ').slice(0, 2).join(' '), 'garbage']);
  assert.equal(result.alreadyListed, 1);
  assert.equal(result.added.length, 2);
  assert.equal(result.skipped, 1);
  assert.deepEqual(stored().map((k) => k.name), ['fixture@wisp', 'octo on GitHub', 'octo on GitHub 2']);
  assert.deepEqual(await settings.importSshKeys('octo', [BARE]), { added: [], alreadyListed: 1, skipped: 0 });
  // Keys all of a type Wisp does not take: none added, each counted as skipped.
  assert.deepEqual(await settings.importSshKeys('old', ['ssh-dss AAAAB3NzaC1kc3M=', 'ssh-dss AAAAB3NzaC1kc3N=']), { added: [], alreadyListed: 0, skipped: 2 });
});

test('a key is renamed and made a default, each alone; a missing id is SSH_KEY_NOT_FOUND', async () => {
  const { id } = await settings.addSshKey({ key: ED });
  await settings.updateSshKey(id, { default: true });
  await settings.updateSshKey(id, { name: 'work laptop' });
  assert.deepEqual(stored()[0], { id, name: 'work laptop', key: ED, default: true });
  await assert.rejects(settings.updateSshKey(id, { name: '  ' }), (err) => err.code === 'INVALID_REQUEST');
  await assert.rejects(settings.updateSshKey('nope', { default: true }), (err) => err.code === 'SSH_KEY_NOT_FOUND');
  await settings.removeSshKey(id);
  assert.deepEqual(stored(), []);
  await assert.rejects(settings.removeSshKey(id), (err) => err.code === 'SSH_KEY_NOT_FOUND');
});

test('the strict read refuses an invalid key, the same key twice and an unknown field', () => {
  const entry = (fields) => ({ id: 'a', name: 'n', key: ED, default: false, ...fields });
  assert.throws(() => parseWispConfig({ sshKeys: [entry({ key: 'nope' })] }), /sshKeys\[0\]\.key/);
  assert.throws(() => parseWispConfig({ sshKeys: [entry(), entry({ id: 'b', key: `${ED} again` })] }), /same key/);
  assert.throws(() => parseWispConfig({ sshKeys: [entry({ source: 'x' })] }), /unknown key/);
  assert.throws(() => parseWispConfig({ sshKeys: [entry({ default: 'yes' })] }), /default/);
  assert.deepEqual(parseWispConfig({}).sshKeys, []);
});
