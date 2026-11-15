import { create } from 'zustand';
import * as sectionsApi from '../api/sections.js';
import { subscribeTopic } from '../api/events.js';

export const MAIN_SECTION_ID = 'main';

const DEFAULT_MAIN = { id: MAIN_SECTION_ID, name: 'Main', order: -Infinity, builtin: true };

function applyEnvelope(set, response) {
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

/** Single subscriber: only one `sections` topic subscription is ever active. Held at
 *  module scope (the store is a singleton) so startSectionsSSE/stopSectionsSSE can
 *  clean up after it. */
let sectionsCloseFn = null;

export const useSectionsStore = create((set, get) => ({
  sections: [DEFAULT_MAIN],
  assignments: {},
  /* Set after a section is created via the create-and-assign flow (ghost
   * zone or picker "+ New section"); the matching SectionHeader reads this
   * to auto-open its rename input on first render, then clears it. */
  pendingRenameId: null,

  /**
   * Subscribe to the `sections` topic on `/api/events`. The server sends the full
   * `{ sections, assignments }` envelope on connect and again after every mutation, so
   * this both seeds the store and keeps it live, its only source — a workload moved from another device
   * (or while this client was suspended in the iOS app switcher) lands here without a
   * reload.
   */
  startSectionsSSE: () => {
    if (sectionsCloseFn) return;
    sectionsCloseFn = subscribeTopic('sections', (data) => {
      if (!data || !Array.isArray(data.sections)) return; // error frame; keep the last good envelope
      applyEnvelope(set, data);
    });
  },

  stopSectionsSSE: () => {
    if (sectionsCloseFn) {
      sectionsCloseFn();
      sectionsCloseFn = null;
    }
  },

  /* Writes answer with an ack; the new envelope arrives on the `sections` topic. */
  renameSection: (id, name) => sectionsApi.renameSection(id, name),

  deleteSection: (id) => sectionsApi.deleteSection(id),

  reorderSections: (orderedIds) => sectionsApi.reorderSections(orderedIds),

  assignWorkload: ({ type, name, sectionId }) => sectionsApi.assignWorkload({ type, name, sectionId }),

  /**
   * Create a new section with an auto-suffixed default name, assign the given
   * workload to it, and flag the new section for auto-rename. Used by both
   * the "Create section" ghost drop zone and the picker's "+ New section"
   * option so the two flows stay in lockstep. The section header opens its
   * rename input when it first renders, whenever the topic brings it.
   */
  createAndAssign: async ({ type, name }) => {
    const defaultName = uniqueDefaultName(get().sections);
    const { id } = await sectionsApi.createSection(defaultName);
    await sectionsApi.assignWorkload({ type, name, sectionId: id });
    set({ pendingRenameId: id });
  },

  clearPendingRenameId: () => set({ pendingRenameId: null }),
}));
