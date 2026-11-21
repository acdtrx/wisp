import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  callbackUrl, ssoForm, ssoProblem, userForm, userProblem, withAddress, withSso, withUser, withoutUser, zotSendable,
} from './zotConfig.js';

const stored = {
  users: [{ username: 'admin', hasPassword: true }, { username: 'ci', hasPassword: true }],
  externalUrl: 'https://registry.example.net',
  oidc: {
    enabled: true, name: 'SSO', issuer: 'https://id.example.net', clientId: 'zot', clientSecret: { isSet: true },
    scopes: ['openid', 'email'], usernameClaim: 'email',
  },
};

test('users are sent by name alone, which keeps their passwords; the secret mask goes back', () => {
  const sent = zotSendable(stored);
  assert.deepEqual(sent.users, [{ username: 'admin' }, { username: 'ci' }]);
  assert.deepEqual(sent.oidc.clientSecret, { isSet: true });
});

test('a user saved replaces its row; a password goes only when typed', () => {
  assert.deepEqual(withUser(stored, 'ci', { username: 'ci', password: 'pw' }).users, [{ username: 'admin' }, { username: 'ci', password: 'pw' }]);
  assert.deepEqual(withUser(stored, null, { username: 'new', password: 'pw' }).users.at(-1), { username: 'new', password: 'pw' });
  assert.deepEqual(withoutUser(stored, 'admin').users, [{ username: 'ci' }]);
});

test('a new or renamed user needs a password; a duplicate is refused', () => {
  assert.equal(userProblem(stored, null, userForm(null)), 'A username is required.');
  assert.equal(userProblem(stored, null, { username: 'x', password: '' }), 'A new user needs a password.');
  assert.equal(userProblem(stored, 'ci', { username: 'ci2', password: '' }), 'A renamed user needs a password.');
  assert.equal(userProblem(stored, 'ci', { username: 'ci', password: '' }), null);
  assert.equal(userProblem(stored, null, { username: 'Admin', password: 'p' }), 'Admin is a user already.');
});

test('the address and sign-in keep the rest of the config', () => {
  assert.equal(withAddress(stored, ' https://r.example.net ').externalUrl, 'https://r.example.net');
  const form = ssoForm(stored);
  assert.equal(form.scopes, 'openid email');
  const sent = withSso(stored, { ...form, clientId: 'zot2' });
  assert.deepEqual(sent.oidc.clientSecret, { isSet: true });
  assert.deepEqual(sent.oidc.scopes, ['openid', 'email']);
  assert.equal(withSso(stored, { ...form, secret: 's' }).oidc.clientSecret, 's');
  assert.deepEqual(sent.users, [{ username: 'admin' }, { username: 'ci' }]);
});

test('sign-in turned on needs the address, issuer, client and secret', () => {
  assert.equal(ssoProblem(stored, ssoForm(stored)), null);
  assert.ok(ssoProblem({ ...stored, externalUrl: '' }, ssoForm(stored)));
  assert.ok(ssoProblem(stored, { ...ssoForm(stored), secretIsSet: false }));
  assert.equal(ssoProblem({}, ssoForm({})), null);
  assert.equal(callbackUrl('https://r.example.net/'), 'https://r.example.net/zot/auth/callback/oidc');
});
