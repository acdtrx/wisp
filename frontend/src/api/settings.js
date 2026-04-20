import { api } from './client.js';

export function getSettings() {
  return api('/api/settings');
}

export function updateSettings(body) {
  return api('/api/settings', { method: 'PATCH', body });
}

export function getMounts() {
  return api('/api/host/mounts');
}

export function getMountStatus() {
  return api('/api/host/mounts/status');
}

export function mountMount(id) {
  return api(`/api/host/mounts/${encodeURIComponent(id)}/mount`, { method: 'POST' });
}

export function unmountMount(id) {
  return api(`/api/host/mounts/${encodeURIComponent(id)}/unmount`, { method: 'POST' });
}

export function checkMountConnection(body) {
  return api('/api/host/mounts/check', { method: 'POST', body });
}

export function addMount(body) {
  return api('/api/host/mounts', { method: 'POST', body });
}

export function patchMount(id, body) {
  return api(`/api/host/mounts/${encodeURIComponent(id)}`, { method: 'PATCH', body });
}

export function deleteMount(id) {
  return api(`/api/host/mounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
