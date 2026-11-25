import { api } from './client.js';

export function getSettings({ signal } = {}) {
  return api('/api/settings', { signal });
}

/** Answers 204: the new settings arrive through the settings store's sync. */
export async function updateSettings(body) {
  await api('/api/settings', { method: 'PATCH', body });
}

/** Answers 204, like `updateSettings`. */
export async function updateOidcSettings(body) {
  await api('/api/settings/oidc', { method: 'PATCH', body });
}

/** The host's certificate: its setting without the token, the certificate Wisp holds, the last attempt. */
export function getCertificate({ signal } = {}) {
  return api('/api/settings/certificate', { signal });
}

/** `{ domain, cloudflareApiToken? }`. Answers 204: the record arrives on the `certificate` cue. */
export async function saveCertificate(body) {
  await api('/api/settings/certificate', { method: 'PUT', body });
}

/** Answers 204, like `saveCertificate`. */
export async function removeCertificate() {
  await api('/api/settings/certificate', { method: 'DELETE' });
}

/** A job: answers `{ jobId, kind, title, subject }`. */
export function renewCertificate() {
  return api('/api/settings/certificate/renew', { method: 'POST' });
}

/** Answers `201 { id }`: the key arrives with the settings (the `settings` cue). */
export function addSshKey(body) {
  return api('/api/settings/ssh-keys', { method: 'POST', body });
}

/** Answers `201 { added, alreadyListed }`: the new keys' ids, and how many were listed already. */
export function importGithubKeys(user) {
  return api('/api/settings/ssh-keys/github', { method: 'POST', body: { user } });
}

/** `{ name }`, `{ default }` or both. Answers 204, like `addSshKey`. */
export async function updateSshKey(id, body) {
  await api(`/api/settings/ssh-keys/${encodeURIComponent(id)}`, { method: 'PATCH', body });
}

/** Answers 204. No VM changes: each keeps its own copy of its keys. */
export async function removeSshKey(id) {
  await api(`/api/settings/ssh-keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function getMountStatus({ signal } = {}) {
  return api('/api/host/mounts/status', { signal });
}

/** Answers 204 once mounted: the status arrives on the `host-mounts` cue. */
export function mountMount(id) {
  return api(`/api/host/mounts/${encodeURIComponent(id)}/mount`, { method: 'POST' });
}

/** A job: answers `{ jobId, kind, title, subject }` (follow with awaitJob). */
export function unmountMount(id) {
  return api(`/api/host/mounts/${encodeURIComponent(id)}/unmount`, { method: 'POST' });
}

export function checkMountConnection(body) {
  return api('/api/host/mounts/check', { method: 'POST', body });
}

/** Answers `201 { id }`: the mount arrives with the settings (the `settings` cue). */
export function addMount(body) {
  return api('/api/host/mounts', { method: 'POST', body });
}

/** Answers 204, like `addMount`. */
export function patchMount(id, body) {
  return api(`/api/host/mounts/${encodeURIComponent(id)}`, { method: 'PATCH', body });
}

/** A job: answers `{ jobId, kind, title, subject }` (follow with awaitJob). */
export function deleteMount(id) {
  return api(`/api/host/mounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
