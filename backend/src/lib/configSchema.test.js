/*
 * The forms a mount is stored in: a mountPath in canonical form, a share as
 * //host/share[/folder] — the forms wisp-mount takes; and the certificate
 * setting's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkMountPath, checkShare, parseWispConfig } from './configSchema.js';

const refused = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err.code;
  }
};

test('a mountPath is stored resolved', () => {
  assert.equal(checkMountPath('/mnt/wisp/nas/'), '/mnt/wisp/nas');
  assert.equal(checkMountPath(' /mnt/wisp//nas '), '/mnt/wisp/nas');
  assert.equal(checkMountPath('/mnt/wisp/a/./b/../c'), '/mnt/wisp/a/c');
  for (const p of ['/mnt/wisp', '/mnt/wisp/', '/mnt/wisp/..', 'mnt/wisp/x', '/etc', '/mnt/wispx']) {
    assert.equal(refused(() => checkMountPath(p)), 'MOUNT_INVALID', p);
  }
});

test('a share is stored as //host/share[/folder]', () => {
  assert.equal(checkShare('//nas/media/'), '//nas/media');
  assert.equal(checkShare('\\\\nas\\media\\films'), '//nas/media/films');
  assert.equal(checkShare(' //nas//media///films// '), '//nas/media/films');
  assert.equal(checkShare('//192.168.1.5/My Share'), '//192.168.1.5/My Share');
  for (const s of ['//nas', '//nas/', 'nas/media', '/nas/media', '//na s/media', '//nas/a,b', '//nas/a\nb', '', null]) {
    assert.equal(refused(() => checkShare(s)), 'MOUNT_INVALID', JSON.stringify(s));
  }
});

test('the strict read takes a mountPath only in canonical form', () => {
  const config = (mountPath) => ({ mounts: [{ id: 'a', type: 'disk', label: 'USB', mountPath, uuid: 'abcd-1234' }] });
  assert.equal(parseWispConfig(config('/mnt/wisp/usb')).mounts[0].mountPath, '/mnt/wisp/usb');
  assert.throws(() => parseWispConfig(config('/mnt/wisp/usb/')), /mountPath must be stored in canonical form \("\/mnt\/wisp\/usb"\)/);
});

test('the certificate setting is read strictly: null, or a lowercase domain and a token', () => {
  assert.equal(parseWispConfig({}).certificate, null);
  assert.equal(parseWispConfig({ certificate: null }).certificate, null);
  const setting = { domain: 'home.example.com', cloudflareApiToken: 't' };
  assert.deepEqual(parseWispConfig({ certificate: setting }).certificate, setting);
  for (const bad of [
    { domain: 'Home.example.com', cloudflareApiToken: 't' },
    { domain: '*.example.com', cloudflareApiToken: 't' },
    { domain: 'example.com', cloudflareApiToken: '' },
    { domain: 'example.com' },
    { domain: 'example.com', cloudflareApiToken: 't', email: 'a@b' },
  ]) {
    assert.equal(refused(() => parseWispConfig({ certificate: bad })), 'CONFIG_INVALID', JSON.stringify(bad));
  }
});
