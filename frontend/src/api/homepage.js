import { api } from './client.js';

/* Writes answer with an ack (204, or `201 { id }` for a create); the new
 * `{ tiles, groups }` envelope arrives on the `home` topic. */

export function getHomepage() {
  return api('/api/homepage');
}

/** @returns {Promise<{ id: string }>} */
export function createGroup(name) {
  return api('/api/homepage/groups', { method: 'POST', body: { name } });
}

export async function renameGroup(id, name) {
  await api(`/api/homepage/groups/${encodeURIComponent(id)}`, { method: 'PATCH', body: { name } });
}

export async function deleteGroup(id) {
  await api(`/api/homepage/groups/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function reorderGroups(ids) {
  await api('/api/homepage/groups/reorder', { method: 'POST', body: { ids } });
}

export async function assignTile({ tileId, groupId, index }) {
  await api('/api/homepage/tiles/assign', {
    method: 'PUT',
    body: { tileId, groupId: groupId ?? null, index: index ?? null },
  });
}

export async function setTileOverride(patch) {
  await api('/api/homepage/tiles/override', { method: 'PUT', body: patch });
}

/** @returns {Promise<{ id: string }>} */
export function addManualTile({ name, url, iconId }) {
  return api('/api/homepage/manual-tiles', {
    method: 'POST',
    body: { name, url, iconId: iconId ?? null },
  });
}

export async function updateManualTile(id, patch) {
  await api(`/api/homepage/manual-tiles/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: patch,
  });
}

export async function removeManualTile(id) {
  await api(`/api/homepage/manual-tiles/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
