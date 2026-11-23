/*
 * Host mounts in the settings file, on a temporary one (WISP_CONFIG_PATH, set before
 * the settings module loads): one mount path per mount.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

const dir = mkdtempSync(path.join(tmpdir(), 'wisp-mounts-test-'));
const file = path.join(dir, 'wisp-config.json');
process.env.WISP_CONFIG_PATH = file;

const settings = await import('./settings.js');

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => writeFileSync(file, '{}\n'));

const smb = (id, mountPath) => ({ id, type: 'smb', label: id, share: '//nas/share', mountPath });
const stored = () => JSON.parse(readFileSync(file, 'utf8')).mounts ?? [];

test('a mount added on a path another mount has is refused, in its canonical form too', async () => {
  await settings.addMount(smb('a', '/mnt/wisp/media'));
  await assert.rejects(settings.addMount(smb('b', '/mnt/wisp/media')), (err) => err.code === 'MOUNT_DUPLICATE' && /\/mnt\/wisp\/media/.test(err.message));
  await assert.rejects(settings.addMount(smb('c', '/mnt/wisp/./other/../media/')), (err) => err.code === 'MOUNT_DUPLICATE');
  assert.deepEqual(stored().map((m) => m.id), ['a']);
});

test('an edit onto another mount\'s path is refused; onto its own, or elsewhere, it saves', async () => {
  await settings.addMount(smb('a', '/mnt/wisp/one'));
  await settings.addMount(smb('b', '/mnt/wisp/two'));
  await assert.rejects(settings.updateMount('b', { mountPath: '/mnt/wisp/one' }), (err) => err.code === 'MOUNT_DUPLICATE');
  await settings.updateMount('b', { mountPath: '/mnt/wisp/two/', label: 'Two' });
  await settings.updateMount('b', { mountPath: '/mnt/wisp/three' });
  assert.deepEqual(stored().map((m) => [m.id, m.mountPath]), [['a', '/mnt/wisp/one'], ['b', '/mnt/wisp/three']]);
});

test('two concurrent adds on one path: only the first is saved', async () => {
  const results = await Promise.allSettled([settings.addMount(smb('a', '/mnt/wisp/same')), settings.addMount(smb('b', '/mnt/wisp/same'))]);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected']);
  assert.equal(results[1].reason.code, 'MOUNT_DUPLICATE');
  assert.equal(stored().length, 1);
});

test('the strict read refuses a settings file with two mounts on one path, naming both', async () => {
  const { parseWispConfig } = await import('./configSchema.js');
  const two = (pathB) => ({ mounts: [smb('a', '/mnt/wisp/media'), { ...smb('b', pathB), label: 'Backups' }] });
  assert.throws(() => parseWispConfig(two('/mnt/wisp/media')),
    (err) => err.code === 'CONFIG_INVALID' && /mounts\[1\]\.mountPath/.test(err.message) && /"a" and "Backups" both use \/mnt\/wisp\/media/.test(err.message));
  assert.doesNotThrow(() => parseWispConfig(two('/mnt/wisp/other')));
});
