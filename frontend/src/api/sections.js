import { api } from './client.js';

/* Writes answer with an ack (204, or `201 { id }` for a create); the new
 * `{ sections, assignments }` envelope arrives on the `sections` topic. */

/** @returns {Promise<{ id: string }>} */
export function createSection(name) {
  return api('/api/sections', { method: 'POST', body: { name } });
}

export async function renameSection(id, name) {
  await api(`/api/sections/${encodeURIComponent(id)}`, { method: 'PATCH', body: { name } });
}

export async function deleteSection(id) {
  await api(`/api/sections/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function reorderSections(ids) {
  await api('/api/sections/reorder', { method: 'POST', body: { ids } });
}

export async function assignWorkload({ type, name, sectionId }) {
  await api('/api/sections/assign', {
    method: 'PUT',
    body: { type, name, sectionId: sectionId ?? null },
  });
}
