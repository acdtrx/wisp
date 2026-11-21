import { test } from 'node:test';
import assert from 'node:assert/strict';

import { caddySendable, domainForm, siteForm, siteProblem, withDomain, withSite, withoutSite } from './caddyConfig.js';

const stored = {
  domain: 'example.net',
  email: 'me@example.net',
  cloudflareDnsEnabled: true,
  cloudflareApiToken: { isSet: true },
  hosts: [{ subdomain: 'photos', target: '192.168.1.20:2342' }, { subdomain: 'files', target: 'samba.local:8080' }],
};

test('a save sends the token mask back, which keeps the stored token', () => {
  assert.deepEqual(caddySendable(stored).cloudflareApiToken, { isSet: true });
  assert.equal(caddySendable({}).cloudflareDnsEnabled, false);
});

test('a site saved replaces its row only; a new one is added', () => {
  const edited = withSite(stored, 'photos', { subdomain: 'Pics', target: ' 192.168.1.21 ' });
  assert.deepEqual(edited.hosts, [{ subdomain: 'pics', target: '192.168.1.21' }, stored.hosts[1]]);
  assert.equal(edited.domain, 'example.net');
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

test('the domain form sends a token only when one is typed', () => {
  const form = domainForm(stored);
  assert.equal(form.tokenIsSet, true);
  assert.deepEqual(withDomain(stored, { ...form, email: '' }).cloudflareApiToken, { isSet: true });
  assert.equal(withDomain(stored, { ...form, token: ' t0k ' }).cloudflareApiToken, 't0k');
  assert.deepEqual(withDomain(stored, form).hosts, stored.hosts);
});
