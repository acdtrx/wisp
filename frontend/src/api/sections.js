import { api } from './client.js';

export function listSections() {
  return api('/api/sections');
}

export function createSection(name) {
  return api('/api/sections', { method: 'POST', body: { name } });
}

export function renameSection(id, name) {
  return api(`/api/sections/${encodeURIComponent(id)}`, { method: 'PATCH', body: { name } });
}

export function deleteSection(id) {
  return api(`/api/sections/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function reorderSections(ids) {
  return api('/api/sections/reorder', { method: 'POST', body: { ids } });
}

export function assignWorkload({ type, name, sectionId }) {
  return api('/api/sections/assign', {
    method: 'PUT',
    body: { type, name, sectionId: sectionId ?? null },
  });
}
