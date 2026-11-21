import { keyTaken, withRow, withoutRow } from '../appConfigRows.js';

/**
 * The Tiny Samba app's config as its groups edit it, pure. The stored config comes
 * masked: a user's password as `{ isSet }`, kept by the server for a user sent by name
 * alone. Every saved share is sent with the name it is stored under (`previousName`), so
 * a rename moves its local files instead of deleting them.
 */

export const PROTOCOLS = ['SMB1', 'SMB2', 'SMB3'];
const ICON_MODEL_ON = 'TimeCapsule6,106';
export const ICON_MODEL_OFF = '-';

const shareKey = (s) => s.name;
const userKey = (u) => u.name;

function sharesSendable(shares) {
  return (shares ?? []).filter(Boolean).map((s) => ({
    name: s.name ?? '',
    previousName: s.name ?? '',
    guest: s.guest === true,
    access: s.guest ? [] : (s.access ?? []).filter(Boolean).map((a) => ({ user: a.user, level: a.level })),
    ...(s.source?.sourceId ? { source: { sourceId: s.source.sourceId, subPath: s.source.subPath ?? '' } } : {}),
  }));
}

/** The config as the PATCH takes it, from the stored (masked) one. */
export function sambaSendable(ac = {}) {
  const server = ac.server ?? {};
  return {
    server: {
      workgroup: server.workgroup ?? 'WORKGROUP',
      netbiosName: server.netbiosName ?? '',
      dataUid: Number.isInteger(server.dataUid) ? server.dataUid : 1000,
      minProtocol: server.minProtocol ?? 'SMB3',
      iconModel: server.iconModel || ICON_MODEL_ON,
    },
    users: (ac.users ?? []).filter(Boolean).map((u) => ({ name: u.name ?? '' })),
    shares: sharesSendable(ac.shares),
  };
}

/* ---- Shares ---- */

/** A share's form: its access as `{ [user]: 'rw' | 'ro' }`. */
export function shareForm(share) {
  return {
    name: share?.name ?? '',
    sourceId: share?.source?.sourceId ?? '',
    subPath: share?.source?.subPath ?? '',
    guest: share?.guest === true,
    access: Object.fromEntries((share?.access ?? []).map((a) => [a.user, a.level])),
  };
}

function shareFromForm(form, users, key) {
  const declared = new Set(users.map((u) => u.name));
  return {
    name: form.name.trim().toLowerCase(),
    ...(key != null ? { previousName: key } : {}),
    guest: form.guest,
    access: form.guest ? [] : Object.entries(form.access)
      .filter(([user, level]) => declared.has(user) && (level === 'rw' || level === 'ro'))
      .map(([user, level]) => ({ user, level }))
      .sort((a, b) => a.user.localeCompare(b.user)),
    ...(form.sourceId ? { source: { sourceId: form.sourceId, subPath: form.subPath.trim() } } : {}),
  };
}

/** The config with the share opened as `key` (null: a new one) saved as `form`. */
export function withShare(ac, key, form) {
  const base = sambaSendable(ac);
  return { ...base, shares: withRow(base.shares, (s) => s.previousName ?? s.name, key, shareFromForm(form, base.users, key)) };
}

export function withoutShare(ac, key) {
  const base = sambaSendable(ac);
  return { ...base, shares: withoutRow(base.shares, shareKey, key) };
}

const storedShare = (ac, key) => (ac.shares ?? []).find((s) => s?.name === key) ?? null;

/** Whether removing the stored share `key` deletes its files on this host: it is kept
 *  there, not on a storage mount. */
export const removalDeletesShareData = (ac, key) => {
  const share = storedShare(ac, key);
  return !!share && !share.source?.sourceId;
};

/** Whether saving `form` over the stored share `key` deletes its files on this host:
 *  a share kept there moved to a storage mount (a rename alone moves the files). */
export const editDeletesShareData = (ac, key, form) => key != null && removalDeletesShareData(ac, key) && !!form.sourceId;

const SHARE_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** Why the share cannot be saved, or null. */
export function shareProblem(ac, key, form) {
  const name = form.name.trim().toLowerCase();
  if (!name) return 'A name is required.';
  if (!SHARE_NAME.test(name)) return 'The name is lowercase letters, digits and dashes.';
  if (keyTaken(sambaSendable(ac).shares, shareKey, name, key)) return `${name} is a share already.`;
  const sub = form.subPath.trim();
  if (form.sourceId && (sub.startsWith('/') || sub.split('/').some((seg) => seg === '..' || seg === '.'))) {
    return 'A sub-path is relative, without "." or ".." parts.';
  }
  const users = new Set(sambaSendable(ac).users.map((u) => u.name));
  if (!form.guest && !Object.entries(form.access).some(([u, l]) => users.has(u) && (l === 'rw' || l === 'ro'))) {
    return 'Give at least one user access, or make it a guest share.';
  }
  return null;
}

/* ---- Users ---- */

export const userForm = (user) => ({ name: user?.name ?? '', password: '' });

/** The config with the user opened as `key` (null: a new one) saved as `form`: a rename
 *  follows into the shares' access. */
export function withUser(ac, key, form) {
  const base = sambaSendable(ac);
  const name = form.name.trim();
  const user = { name, ...(form.password ? { password: form.password } : {}) };
  const shares = key == null || key === name ? base.shares : base.shares.map((s) => ({
    ...s, access: s.access.map((a) => (a.user === key ? { ...a, user: name } : a)),
  }));
  return { ...base, users: withRow(base.users, userKey, key, user), shares };
}

/** The config without the user, and without its access to any share. */
export function withoutUser(ac, key) {
  const base = sambaSendable(ac);
  return {
    ...base,
    users: withoutRow(base.users, userKey, key),
    shares: base.shares.map((s) => ({ ...s, access: s.access.filter((a) => a.user !== key) })),
  };
}

/** The shares a user's removal would leave with nobody (they then refuse the save). */
export function sharesOnlyUserReaches(ac, key) {
  return sambaSendable(ac).shares
    .filter((s) => !s.guest && s.access.length > 0 && s.access.every((a) => a.user === key))
    .map((s) => s.name);
}

const USER_NAME = /^[a-z][a-z0-9._-]*$/;

/** Why the user cannot be saved, or null. A new or renamed user needs a password: the
 *  stored one is kept by name. */
export function userProblem(ac, key, form) {
  const name = form.name.trim();
  if (!name) return 'A name is required.';
  if (!USER_NAME.test(name)) return 'Lowercase letters, digits, dots, dashes and underscores, starting with a letter.';
  if (keyTaken(sambaSendable(ac).users, userKey, name, key)) return `${name} is a user already.`;
  if (name !== key && !form.password) return key == null ? 'A new user needs a password.' : 'A renamed user needs a password.';
  if (form.password.startsWith('$NT$') && !/^\$NT\$[0-9a-fA-F]{32}$/.test(form.password)) return 'An NT hash is $NT$ and 32 hex digits.';
  return null;
}

/* ---- Server ---- */

/** The server's form: `iconModel` as stored, whichever model it names; the form offers
 *  only on and off, and changes it only when that control is changed. */
export const serverForm = (ac = {}) => {
  const s = sambaSendable(ac).server;
  return { ...s, dataUid: String(s.dataUid) };
};

/** The form with Apple extensions turned on or off (`start`: the form as it opened):
 *  on again, it takes back the stored model, or the default when the stored one was off. */
export const withAppleExtensions = (form, start, on) => ({
  ...form,
  iconModel: on ? (start.iconModel !== ICON_MODEL_OFF ? start.iconModel : ICON_MODEL_ON) : ICON_MODEL_OFF,
});

export const withServer = (ac, form) => ({
  ...sambaSendable(ac),
  server: {
    workgroup: form.workgroup.trim(),
    netbiosName: form.netbiosName.trim(),
    dataUid: Number(form.dataUid),
    minProtocol: form.minProtocol,
    iconModel: form.iconModel,
  },
});

const NETBIOS = /^[A-Za-z0-9_-]{1,15}$/;

/** Why the server's values cannot be saved, by field (none: an empty object). */
export function serverProblems(form) {
  const problems = {};
  if (!NETBIOS.test(form.workgroup.trim())) problems.workgroup = '1 to 15 letters, digits, dashes or underscores.';
  if (!NETBIOS.test(form.netbiosName.trim())) problems.netbiosName = '1 to 15 letters, digits, dashes or underscores.';
  const uid = Number(form.dataUid);
  if (form.dataUid.trim() === '' || !Number.isInteger(uid) || uid < 0 || uid > 65535) problems.dataUid = 'A whole number from 0 to 65535.';
  return problems;
}
