import { api } from './client.js';

/* Every call returns the same `{ tiles, groups }` envelope the `home` topic
 * pushes, so the store can apply a mutation's response directly. */

export function getHomepage() {
  return api('/api/homepage');
}

export function createGroup(name) {
  return api('/api/homepage/groups', { method: 'POST', body: { name } });
}

export function renameGroup(id, name) {
  return api(`/api/homepage/groups/${encodeURIComponent(id)}`, { method: 'PATCH', body: { name } });
}

export function deleteGroup(id) {
  return api(`/api/homepage/groups/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function reorderGroups(ids) {
  return api('/api/homepage/groups/reorder', { method: 'POST', body: { ids } });
}

export function assignTile({ tileId, groupId, index }) {
  return api('/api/homepage/tiles/assign', {
    method: 'PUT',
    body: { tileId, groupId: groupId ?? null, index: index ?? null },
  });
}

export function setTileOverride(patch) {
  return api('/api/homepage/tiles/override', { method: 'PUT', body: patch });
}

export function addManualTile({ name, url, iconId }) {
  return api('/api/homepage/manual-tiles', {
    method: 'POST',
    body: { name, url, iconId: iconId ?? null },
  });
}

export function updateManualTile(id, patch) {
  return api(`/api/homepage/manual-tiles/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: patch,
  });
}

export function removeManualTile(id) {
  return api(`/api/homepage/manual-tiles/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
