import { create } from 'zustand';
import * as sectionsApi from '../api/sections.js';

export const MAIN_SECTION_ID = 'main';

const DEFAULT_MAIN = { id: MAIN_SECTION_ID, name: 'Main', order: -Infinity, builtin: true };

function applyResponse(set, response) {
  const sections = response?.sections?.length ? response.sections : [DEFAULT_MAIN];
  const assignments = response?.assignments && typeof response.assignments === 'object'
    ? response.assignments
    : {};
  set({ sections, assignments });
  return response;
}

/**
 * Resolve the section id for a workload using the locally-cached assignments
 * map. Falls back to Main when no assignment exists or the assignment points
 * at a section that no longer exists.
 */
export function selectSectionId(state, type, name) {
  const key = `${type}:${name}`;
  const id = state.assignments?.[key];
  if (!id) return MAIN_SECTION_ID;
  const exists = state.sections.some((s) => s.id === id);
  return exists ? id : MAIN_SECTION_ID;
}

function uniqueDefaultName(sections) {
  const taken = new Set(sections.map((s) => s.name.toLowerCase()));
  let candidate = 'New Section';
  let n = 2;
  while (taken.has(candidate.toLowerCase())) {
    candidate = `New Section ${n++}`;
  }
  return candidate;
}

export const useSectionsStore = create((set, get) => ({
  sections: [DEFAULT_MAIN],
  assignments: {},
  /* Set after a section is created via the create-and-assign flow (ghost
   * zone or picker "+ New section"); the matching SectionHeader reads this
   * to auto-open its rename input on first render, then clears it. */
  pendingRenameId: null,
  loading: false,
  error: null,

  loadSections: async () => {
    set({ loading: true, error: null });
    try {
      const response = await sectionsApi.listSections();
      applyResponse(set, response);
      set({ loading: false });
      return response;
    } catch (err) {
      set({ error: err.message, loading: false });
      throw err;
    }
  },

  createSection: async (name) => {
    const response = await sectionsApi.createSection(name);
    return applyResponse(set, response);
  },

  renameSection: async (id, name) => {
    const response = await sectionsApi.renameSection(id, name);
    return applyResponse(set, response);
  },

  deleteSection: async (id) => {
    const response = await sectionsApi.deleteSection(id);
    return applyResponse(set, response);
  },

  reorderSections: async (orderedIds) => {
    const response = await sectionsApi.reorderSections(orderedIds);
    applyResponse(set, response);
  },

  assignWorkload: async ({ type, name, sectionId }) => {
    const response = await sectionsApi.assignWorkload({ type, name, sectionId });
    applyResponse(set, response);
  },

  /**
   * Create a new section with an auto-suffixed default name, assign the given
   * workload to it, and flag the new section for auto-rename. Used by both
   * the "Create section" ghost drop zone and the picker's "+ New section"
   * option so the two flows stay in lockstep.
   */
  createAndAssign: async ({ type, name }) => {
    const defaultName = uniqueDefaultName(get().sections);
    const created = await sectionsApi.createSection(defaultName);
    applyResponse(set, created);
    const newSection = (created.sections || []).find(
      (s) => s.name.toLowerCase() === defaultName.toLowerCase(),
    );
    if (!newSection) return;
    const assigned = await sectionsApi.assignWorkload({ type, name, sectionId: newSection.id });
    applyResponse(set, assigned);
    set({ pendingRenameId: newSection.id });
  },

  clearPendingRenameId: () => set({ pendingRenameId: null }),
}));
