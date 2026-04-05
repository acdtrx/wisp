import { api } from './client.js';

export function getSettings() {
  return api('/api/settings');
}

export function updateSettings(body) {
  return api('/api/settings', { method: 'PATCH', body });
}

export function getNetworkMountStatus() {
  return api('/api/settings/network-mounts/status');
}

export function mountNetworkMount(id) {
  return api(`/api/settings/network-mounts/${encodeURIComponent(id)}/mount`, { method: 'POST' });
}

export function unmountNetworkMount(id) {
  return api(`/api/settings/network-mounts/${encodeURIComponent(id)}/unmount`, { method: 'POST' });
}

export function checkNetworkMountConnection(body) {
  return api('/api/settings/network-mounts/check', { method: 'POST', body });
}

export function addNetworkMount(body) {
  return api('/api/settings/network-mounts', { method: 'POST', body });
}

export function patchNetworkMount(id, body) {
  return api(`/api/settings/network-mounts/${encodeURIComponent(id)}`, { method: 'PATCH', body });
}

export function deleteNetworkMount(id) {
  return api(`/api/settings/network-mounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
