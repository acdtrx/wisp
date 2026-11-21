import { keyTaken, withRow, withoutRow } from '../appConfigRows.js';

/**
 * The Zot registry's config as its groups edit it, pure. The stored config comes masked:
 * a user as `{ username, hasPassword }` (the server keeps a user's hash by username when
 * no password is sent), the OIDC secret as `{ isSet }` (sent back, it keeps the stored
 * one).
 */

export const USERNAME_CLAIMS = ['preferred_username', 'email', 'sub', 'name'];
const DEFAULT_SCOPES = ['openid', 'profile', 'email'];

const userKey = (u) => u.username;

function oidcSendable(oidc = {}) {
  return {
    enabled: oidc.enabled === true,
    name: oidc.name ?? '',
    issuer: oidc.issuer ?? '',
    clientId: oidc.clientId ?? '',
    clientSecret: { isSet: oidc.clientSecret?.isSet === true },
    scopes: Array.isArray(oidc.scopes) && oidc.scopes.length > 0 ? oidc.scopes : DEFAULT_SCOPES,
    usernameClaim: oidc.usernameClaim || USERNAME_CLAIMS[0],
  };
}

/** The config as the PATCH takes it, from the stored (masked) one. */
export function zotSendable(ac = {}) {
  return {
    users: (ac.users ?? []).filter(Boolean).map((u) => ({ username: u.username ?? '' })),
    externalUrl: ac.externalUrl ?? '',
    oidc: oidcSendable(ac.oidc),
  };
}

/* ---- Users ---- */

export const userForm = (user) => ({ username: user?.username ?? '', password: '' });

/** The config with the user opened as `key` (null: a new one) saved as `form`; a
 *  password goes only when typed. */
export function withUser(ac, key, form) {
  const base = zotSendable(ac);
  const user = { username: form.username.trim(), ...(form.password ? { password: form.password } : {}) };
  return { ...base, users: withRow(base.users, userKey, key, user) };
}

export function withoutUser(ac, key) {
  const base = zotSendable(ac);
  return { ...base, users: withoutRow(base.users, userKey, key) };
}

/** Why the user cannot be saved, or null. A new or renamed user needs a password: the
 *  stored hash is kept by username. */
export function userProblem(ac, key, form) {
  const name = form.username.trim();
  if (!name) return 'A username is required.';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) return 'Letters, digits, dots, dashes and underscores, starting with a letter or digit.';
  const lower = (list) => list.map((u) => ({ username: u.username.toLowerCase() }));
  if (keyTaken(lower(zotSendable(ac).users), userKey, name.toLowerCase(), key?.toLowerCase())) return `${name} is a user already.`;
  if (name !== key && !form.password) return key == null ? 'A new user needs a password.' : 'A renamed user needs a password.';
  return null;
}

/* ---- Address ---- */

export const withAddress = (ac, externalUrl) => ({ ...zotSendable(ac), externalUrl: externalUrl.trim() });

/* ---- Sign-in (SSO) ---- */

export function ssoForm(ac = {}) {
  const oidc = oidcSendable(ac.oidc);
  return {
    enabled: oidc.enabled,
    name: oidc.name,
    issuer: oidc.issuer,
    clientId: oidc.clientId,
    secret: '',
    secretIsSet: oidc.clientSecret.isSet,
    scopes: oidc.scopes.join(' '),
    usernameClaim: oidc.usernameClaim,
  };
}

/** The config with the sign-in values: the secret only when one was typed. */
export function withSso(ac, form) {
  const base = zotSendable(ac);
  return {
    ...base,
    oidc: {
      enabled: form.enabled,
      name: form.name.trim(),
      issuer: form.issuer.trim(),
      clientId: form.clientId.trim(),
      clientSecret: form.secret ? form.secret : base.oidc.clientSecret,
      scopes: form.scopes.split(/[\s,]+/).filter(Boolean),
      usernameClaim: form.usernameClaim,
    },
  };
}

/** Why sign-in cannot be turned on with these values, or null. */
export function ssoProblem(ac, form) {
  if (!form.enabled) return null;
  if (!(ac.externalUrl ?? '').trim()) return 'Set the registry’s address first: it is the base of the sign-in redirect.';
  if (!form.issuer.trim()) return 'An issuer URL is required.';
  if (!form.clientId.trim()) return 'A client ID is required.';
  if (!form.secret && !form.secretIsSet) return 'A client secret is required.';
  if (!form.scopes.split(/[\s,]+/).includes('openid')) return 'The scopes include openid.';
  return null;
}

/** The redirect URI to register with the provider, or null without an address. */
export const callbackUrl = (externalUrl) => (externalUrl?.trim()
  ? `${externalUrl.trim().replace(/\/+$/, '')}/zot/auth/callback/oidc`
  : null);
