import * as sectionsApi from '../api/sections.js';
import { TOPIC } from '../../../shared/wireNames.js';
import { createStreamStore, topicSource } from './streamStore.js';

export const MAIN_SECTION_ID = 'main';

const DEFAULT_MAIN = { id: MAIN_SECTION_ID, name: 'Main', order: -Infinity, builtin: true };

/** The envelope a frame carries, Main filled in; `undefined` for a frame that is not one. */
function envelopeOf(frame) {
  if (!frame || !Array.isArray(frame.sections)) return undefined;
  return {
    sections: frame.sections.length ? frame.sections : [DEFAULT_MAIN],
    assignments: frame.assignments && typeof frame.assignments === 'object' ? frame.assignments : {},
  };
}

/**
 * Resolve the section id for a workload using the locally-cached assignments
 * map. Falls back to Main when no assignment exists or the assignment points
 * at a section that no longer exists.
 */
export function selectSectionId({ sections, assignments }, type, name) {
  const key = `${type}:${name}`;
  const id = assignments[key];
  if (!id) return MAIN_SECTION_ID;
  const exists = sections.some((s) => s.id === id);
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

/**
 * The sidebar's sections, from the `sections` topic: `data` is the
 * `{ sections, assignments }` envelope, which the server sends on connect and
 * after every write, so a workload moved from another device lands here without
 * a reload.
 */
export const useSectionsStore = createStreamStore({
  source: topicSource(TOPIC.SECTIONS),
  toData: envelopeOf,
  empty: { sections: [DEFAULT_MAIN], assignments: {} },
  extend: (set, get) => ({
    /* Set after a section is created via the create-and-assign flow (ghost
     * zone or picker "+ New section"); the matching SectionHeader reads this
     * to auto-open its rename input on first render, then clears it. */
    pendingRenameId: null,

    /* Writes answer with an ack; each resolves once the new envelope has arrived on
     * the `sections` topic too. */
    renameSection: (id, name) => sectionsApi.renameSection(id, name),

    deleteSection: (id) => sectionsApi.deleteSection(id),

    reorderSections: (orderedIds) => sectionsApi.reorderSections(orderedIds),

    assignWorkload: ({ type, name, sectionId }) =>
      sectionsApi.assignWorkload({ type, name, sectionId }),

    /**
     * Create a new section with an auto-suffixed default name, assign the given
     * workload to it, and flag the new section for auto-rename. Used by both
     * the "Create section" ghost drop zone and the picker's "+ New section"
     * option so the two flows stay in lockstep. The section header opens its
     * rename input when it first renders, whenever the topic brings it.
     */
    createAndAssign: async ({ type, name }) => {
      const defaultName = uniqueDefaultName(get().data.sections);
      const { id } = await sectionsApi.createSection(defaultName);
      await sectionsApi.assignWorkload({ type, name, sectionId: id });
      set({ pendingRenameId: id });
    },

    clearPendingRenameId: () => set({ pendingRenameId: null }),
  }),
});
