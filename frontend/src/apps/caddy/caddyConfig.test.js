import { test } from 'node:test';
import assert from 'node:assert/strict';

import { caddySendable, siteForm, siteName, siteProblem, withSite, withoutSite } from './caddyConfig.js';

const stored = {
  hosts: [{ subdomain: 'photos', target: '192.168.1.20:2342' }, { subdomain: 'files', target: 'samba.local:8080' }],
};

test('a save sends the sites alone: the domain is the host certificate\'s', () => {
  assert.deepEqual(Object.keys(caddySendable(stored)), ['hosts']);
  assert.deepEqual(caddySendable({}), { hosts: [] });
});

test('a site saved replaces its row only; a new one is added', () => {
  const edited = withSite(stored, 'photos', { subdomain: 'Pics', target: ' 192.168.1.21 ' });
  assert.deepEqual(edited, { hosts: [{ subdomain: 'pics', target: '192.168.1.21' }, stored.hosts[1]] });
  assert.equal(withSite(stored, null, siteForm({ subdomain: 'ha', target: 'ha.local' })).hosts.length, 3);
});

test('a site removed leaves the others', () => {
  assert.deepEqual(withoutSite(stored, 'photos').hosts, [stored.hosts[1]]);
});

test('a site needs a free DNS label and a target', () => {
  assert.equal(siteProblem(stored, null, { subdomain: 'files', target: 'x' }), 'files is a site already.');
  assert.equal(siteProblem(stored, 'files', { subdomain: 'files', target: 'x' }), null);
  assert.ok(siteProblem(stored, null, { subdomain: 'a b', target: 'x' }));
  assert.ok(siteProblem(stored, null, { subdomain: 'ok', target: '' }));
});

test("a site's full name is under the certificate's domain once there is one", () => {
  assert.equal(siteName('photos', 'home.example.com'), 'photos.home.example.com');
  assert.equal(siteName('photos', null), 'photos');
});
