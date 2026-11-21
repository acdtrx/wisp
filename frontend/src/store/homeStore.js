import * as homeApi from '../api/homepage.js';
import { TOPIC } from '../../../shared/wireNames.js';
import { createStreamStore, topicSource } from './streamStore.js';

export const UNGROUPED_GROUP_ID = 'ungrouped';

/** The `{ tiles, groups }` envelope a frame carries; `undefined` for a frame that is not one. */
function envelopeOf(frame) {
  if (!frame || !Array.isArray(frame.tiles) || !Array.isArray(frame.groups)) return undefined;
  return { tiles: frame.tiles, groups: frame.groups };
}

function uniqueDefaultName(groups) {
  const taken = new Set(groups.map((g) => g.name.toLowerCase()));
  let candidate = 'New Group';
  let n = 2;
  while (taken.has(candidate.toLowerCase())) {
    candidate = `New Group ${n++}`;
  }
  return candidate;
}

/**
 * Home page state, from the `home` topic: `data` is the `{ tiles, groups }`
 * envelope (null until the first frame), which the server pushes on connect
 * and whenever a workload, an app config or the homepage overlay changes, so a
 * service starting on another device's watch lights its lantern here without a
 * reload.
 */
export const useHomeStore = createStreamStore({
  source: topicSource(TOPIC.HOME),
  toData: envelopeOf,
  extend: (set, get) => ({
    /* Set after a group is created so the matching header opens its rename input
     * on first render, then clears it — same flow as the sidebar's new section. */
    pendingRenameId: null,

    /* Writes answer with an ack; each resolves once the new envelope has arrived on
     * the `home` topic too. */

    /** Create a group with a default name and flag it for rename: its header opens
     *  the rename input when it first renders, whenever the topic brings it.
     *  @returns {Promise<string>} the new group's id */
    createGroup: async () => {
      const name = uniqueDefaultName(get().data?.groups ?? []);
      const { id } = await homeApi.createGroup(name);
      set({ pendingRenameId: id });
      return id;
    },

    renameGroup: (id, name) => homeApi.renameGroup(id, name),

    deleteGroup: (id) => homeApi.deleteGroup(id),

    reorderGroups: (ids) => homeApi.reorderGroups(ids),

    assignTile: ({ tileId, groupId, index }) =>
      homeApi.assignTile({ tileId, groupId, index }),

    setTileOverride: (patch) => homeApi.setTileOverride(patch),

    addManualTile: (tile) => homeApi.addManualTile(tile),

    updateManualTile: (id, patch) => homeApi.updateManualTile(id, patch),

    removeManualTile: (id) => homeApi.removeManualTile(id),

    clearPendingRenameId: () => set({ pendingRenameId: null }),
  }),
});
