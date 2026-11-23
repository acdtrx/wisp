/**
 * The settings groups' forms, pure (docs/specs/SETTINGS.md): what each Edit starts from
 * (the settings record, `GET /api/settings`), what keeps it from saving, and what it
 * sends (only what changed, through `changedFields`). Each group's Save is one request:
 * `PATCH /api/settings`, or `PATCH /api/settings/oidc` for single sign-on.
 */
import { changedFields } from '../../hooks/editorValues.js';
import { destinationOrder } from '../../utils/backupDestinations.js';

const trim = (v) => String(v ?? '').trim();

/** The fields of `sent(form)` that differ from `sent(start)`: what a Save sends. */
export const changedSent = (sent, form, start) => changedFields(sent(form), sent(start));

// ─── This server ────────────────────────────────

export const serverForm = (settings) => ({ serverName: settings.serverName ?? '', advertisedUrl: settings.advertisedUrl ?? '' });

/** No name is null (the server's default name); no URL is null (the default announcement). */
export const serverSent = (form) => ({ serverName: trim(form.serverName) || null, advertisedUrl: trim(form.advertisedUrl) || null });

/** Why a URL field's value is no http or https URL (`what` names it), or null; empty is fine. */
function urlProblem(value, what) {
  const url = trim(value);
  if (!url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    // The refusal is the answer: this problem is shown beside the field.
    return `The ${what} is a full URL: http://… or https://…`;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? null : `The ${what} starts with http:// or https://`;
}

export const serverProblem = (form) => urlProblem(form.advertisedUrl, 'advertised URL');

// ─── Storage paths ──────────────────────────────

export const pathsForm = (settings) => ({ vmsPath: settings.vmsPath ?? '', imagePath: settings.imagePath ?? '' });

export const pathsSent = (form) => ({ vmsPath: trim(form.vmsPath), imagePath: trim(form.imagePath) });

export function pathsProblem(form) {
  if (!trim(form.vmsPath).startsWith('/')) return 'The VM storage path is an absolute path: it starts with /.';
  if (!trim(form.imagePath).startsWith('/')) return 'The image library path is an absolute path: it starts with /.';
  return null;
}

// ─── Backup ─────────────────────────────────────

const MOUNT_KIND = { smb: 'SMB share', disk: 'Drive' };

/** A mount as the backup picker names it: its label (else its id), and its kind. */
export const mountText = (m) => `${trim(m.label) || m.id} (${MOUNT_KIND[m.type] ?? m.type})`;

export const backupForm = (settings) => ({ backupLocalPath: settings.backupLocalPath ?? '', backupMountId: settings.backupMountId ?? '' });

/** No second destination is null. */
export const backupSent = (form) => ({ backupLocalPath: trim(form.backupLocalPath), backupMountId: form.backupMountId || null });

export const backupProblem = (form) => (trim(form.backupLocalPath).startsWith('/') ? null : 'The local backup path is an absolute path: it starts with /.');

// ─── Scheduled backups ──────────────────────────

const DEFAULT_SCHEDULE = { enabled: false, time: '03:00', destinationIds: ['local'], retainDays: 7, retainWeeks: 4 };
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export const scheduleOf = (settings) => ({ ...DEFAULT_SCHEDULE, ...(settings.backupSchedule ?? {}) });

export const scheduleForm = (settings) => {
  const s = scheduleOf(settings);
  return { time: s.time, destinationIds: [...s.destinationIds], retainDays: String(s.retainDays), retainWeeks: String(s.retainWeeks) };
};

/** The destinations in the order a backup writes them; the retention as numbers. */
export const scheduleSent = (form, settings) => ({
  time: form.time,
  destinationIds: destinationOrder(form.destinationIds, settings.mounts),
  retainDays: Number(form.retainDays),
  retainWeeks: Number(form.retainWeeks),
});

const wholeIn = (value, min, max) => {
  const text = trim(value);
  const n = Number(text);
  return /^\d+$/.test(text) && n >= min && n <= max;
};

export function scheduleProblem(form) {
  if (!TIME.test(form.time)) return 'The time is HH:MM, 24-hour.';
  if (form.destinationIds.length === 0) return 'Pick at least one destination.';
  if (!wholeIn(form.retainDays, 1, 365)) return 'Keep days is a whole number from 1 to 365.';
  if (!wholeIn(form.retainWeeks, 0, 52)) return 'Keep weeks is a whole number from 0 to 52.';
  return null;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The retention in words. */
export function keepText(s) {
  const days = `the newest per day for ${plural(s.retainDays, 'day', 'days')}`;
  return s.retainWeeks > 0 ? `${days}, then one per week for ${plural(s.retainWeeks, 'week', 'weeks')}` : days;
}

// ─── Single sign-on ─────────────────────────────

/** The client secret is write-only: never read back, so the field starts empty. */
export const oidcForm = (settings) => ({ issuer: settings.oidc?.issuer ?? '', clientId: settings.oidc?.clientId ?? '', clientSecret: '' });

/** The issuer and client trimmed; the secret only when one is typed (empty keeps the stored one). */
export const oidcSent = (form) => ({
  issuer: trim(form.issuer),
  clientId: trim(form.clientId),
  ...(form.clientSecret ? { clientSecret: form.clientSecret } : {}),
});

/** Whether the values need the secret typed again: the stored secret belongs to the
 *  stored issuer and client, and the server never reuses it for another. */
export function secretOwed(form, settings) {
  const oidc = settings.oidc ?? {};
  return !!oidc.hasClientSecret && !!trim(form.issuer) && !!trim(form.clientId)
    && (trim(form.issuer) !== trim(oidc.issuer) || trim(form.clientId) !== trim(oidc.clientId));
}

export const oidcProblem = (form, settings) => urlProblem(form.issuer, 'issuer URL')
  ?? (secretOwed(form, settings) && !form.clientSecret ? 'Re-enter the client secret when changing the issuer or client ID.' : null);

/** Why the SSO switch cannot turn on, or null: it needs the issuer, client ID and secret stored. */
export function ssoSwitchReason(settings) {
  const oidc = settings.oidc ?? {};
  if (oidc.enabled) return null;
  return trim(oidc.issuer) && trim(oidc.clientId) && oidc.hasClientSecret ? null : 'Set the issuer, client ID and secret first';
}

/** The callback URL to register with the provider: on the advertised URL's origin when
 *  one is set (and is a URL), else on `origin`, the one the page is reached on. */
export function callbackUrl(advertisedUrl, origin) {
  try {
    return new URL('/api/auth/oidc/callback', advertisedUrl || origin).href;
  } catch {
    return `${origin}/api/auth/oidc/callback`; // an advertised URL that is no URL: the page's own origin (above)
  }
}
