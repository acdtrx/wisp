import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  backupForm, backupProblem, backupSent, callbackUrl, changedSent, keepText, mountText, oidcForm, oidcProblem, oidcSent,
  pathsForm, pathsProblem, pathsSent, scheduleForm, scheduleOf, scheduleProblem, scheduleSent, serverForm, serverProblem,
  serverSent, ssoSwitchReason,
} from './settingsForms.js';

const SETTINGS = {
  serverName: 'tini', vmsPath: '/var/lib/wisp/vms', imagePath: '/var/lib/wisp/images', backupLocalPath: '/var/lib/wisp/backups',
  advertisedUrl: null, backupMountId: 'nas',
  mounts: [{ id: 'nas', type: 'smb', label: 'NAS', mountPath: '/mnt/wisp/nas' }, { id: 'usb', type: 'disk', label: '', mountPath: '/mnt/wisp/usb' }],
  backupSchedule: { enabled: true, time: '03:00', destinationIds: ['nas', 'local'], retainDays: 7, retainWeeks: 4 },
  oidc: { enabled: false, issuer: 'https://id.example.com', clientId: 'wisp', hasClientSecret: true },
};

test('this server: only what changed is sent; empty is null; the URL must be http(s)', () => {
  const start = serverForm(SETTINGS);
  assert.deepEqual(changedSent(serverSent, { ...start, serverName: '  box ' }, start), { serverName: 'box' });
  assert.deepEqual(changedSent(serverSent, { ...start, serverName: '' }, start), { serverName: null });
  assert.deepEqual(changedSent(serverSent, start, start), {});
  assert.equal(serverProblem({ advertisedUrl: '' }), null);
  assert.equal(serverProblem({ advertisedUrl: 'https://wisp.example.com' }), null);
  assert.match(serverProblem({ advertisedUrl: 'wisp.local' }), /full URL/);
  assert.match(serverProblem({ advertisedUrl: 'ftp://wisp' }), /http/);
});

test('storage paths and backup: absolute paths, trimmed; no second destination is null', () => {
  const paths = pathsForm(SETTINGS);
  assert.deepEqual(changedSent(pathsSent, { ...paths, imagePath: ' /srv/images ' }, paths), { imagePath: '/srv/images' });
  assert.match(pathsProblem({ ...paths, vmsPath: 'vms' }), /VM storage path/);
  const backup = backupForm(SETTINGS);
  assert.deepEqual(changedSent(backupSent, { ...backup, backupMountId: '' }, backup), { backupMountId: null });
  assert.match(backupProblem({ backupLocalPath: 'backups' }), /absolute/);
  assert.deepEqual(SETTINGS.mounts.map(mountText), ['NAS (SMB share)', 'usb (Drive)']);
});

test('the schedule: refused out of range, never clamped; sent in the destinations’ order, only what changed', () => {
  const start = scheduleForm(SETTINGS);
  assert.equal(scheduleProblem(start), null);
  assert.match(scheduleProblem({ ...start, retainDays: '400' }), /1 to 365/);
  assert.match(scheduleProblem({ ...start, retainDays: '0' }), /1 to 365/);
  assert.match(scheduleProblem({ ...start, retainWeeks: '2.5' }), /0 to 52/);
  assert.equal(scheduleProblem({ ...start, retainWeeks: '0' }), null);
  assert.match(scheduleProblem({ ...start, destinationIds: [] }), /at least one/);
  assert.match(scheduleProblem({ ...start, time: '25:00' }), /HH:MM/);
  const sent = (f) => scheduleSent(f, SETTINGS);
  assert.deepEqual(changedSent(sent, { ...start, retainWeeks: '8' }, start), { retainWeeks: 8 });
  assert.deepEqual(sent(start).destinationIds, ['local', 'nas']);
  assert.equal(keepText(scheduleOf(SETTINGS)), 'the newest per day for 7 days, then one per week for 4 weeks');
  assert.equal(keepText({ retainDays: 1, retainWeeks: 0 }), 'the newest per day for 1 day');
  assert.deepEqual(scheduleOf({}).destinationIds, ['local']);
});

test('single sign-on: the secret write-only and owed again for a new issuer or client; the switch waits for all three', () => {
  const start = oidcForm(SETTINGS);
  assert.equal(start.clientSecret, '');
  assert.deepEqual(changedSent(oidcSent, start, start), {});
  assert.deepEqual(changedSent(oidcSent, { ...start, clientSecret: 's3' }, start), { clientSecret: 's3' });
  const moved = { ...start, issuer: 'https://other.example.com' };
  assert.match(oidcProblem(moved, SETTINGS), /Re-enter the client secret/);
  assert.equal(oidcProblem({ ...moved, clientSecret: 'new' }, SETTINGS), null);
  assert.equal(oidcProblem(start, SETTINGS), null);
  assert.equal(ssoSwitchReason(SETTINGS), null);
  assert.match(ssoSwitchReason({ oidc: { enabled: false, issuer: 'https://x', clientId: 'w', hasClientSecret: false } }), /first/);
  // Turning it off is always allowed.
  assert.equal(ssoSwitchReason({ oidc: { enabled: true, issuer: '', clientId: '', hasClientSecret: false } }), null);
});

test('the callback URL is on the advertised URL’s origin, else on the page’s', () => {
  assert.equal(callbackUrl('https://wisp.example.com/some/path', 'http://tini:8080'), 'https://wisp.example.com/api/auth/oidc/callback');
  assert.equal(callbackUrl(null, 'http://tini:8080'), 'http://tini:8080/api/auth/oidc/callback');
});
