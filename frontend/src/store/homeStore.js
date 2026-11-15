import { create } from 'zustand';
import * as homeApi from '../api/homepage.js';
import { subscribeTopic } from '../api/events.js';

export const UNGROUPED_GROUP_ID = 'ungrouped';

function applyEnvelope(set, response) {
  if (!response || !Array.isArray(response.tiles) || !Array.isArray(response.groups)) {
    return response;
  }
  set({ tiles: response.tiles, groups: response.groups, loaded: true, loadError: null });
  return response;
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

/** Single subscriber: only one `home` topic subscription is ever active. Held at
 *  module scope (the store is a singleton) so start/stop can clean up after it. */
let homeCloseFn = null;

/**
 * Home page state. Mirrors `sectionsStore`: the `home` topic on `/api/events` is
 * the steady-state source — the server pushes the full `{ tiles, groups }`
 * envelope on connect and again whenever a workload, an app config, or the
 * homepage overlay changes, so a service starting on another device's watch
 * lights its lantern here without a reload.
 */
export const useHomeStore = create((set, get) => ({
  tiles: [],
  groups: [],
  loaded: false,
  /** The home stream's last error (the tiles shown are the last good ones). */
  loadError: null,
  /* Set after a group is created so the matching header opens its rename input
   * on first render, then clears it — same flow as the sidebar's new section. */
  pendingRenameId: null,

  startHomeSSE: () => {
    if (homeCloseFn) return;
    homeCloseFn = subscribeTopic('home', (data) => {
      if (data && data.error) {
        set({ loadError: data.detail || data.error }); // keep the last good envelope
        return;
      }
      if (!data || !Array.isArray(data.tiles)) return;
      applyEnvelope(set, data);
    });
  },

  stopHomeSSE: () => {
    if (homeCloseFn) {
      homeCloseFn();
      homeCloseFn = null;
    }
  },

  /* Writes answer with an ack; the new envelope arrives on the `home` topic. */

  /** Create a group with a default name and flag it for rename: its header opens
   *  the rename input when it first renders, whenever the topic brings it.
   *  @returns {Promise<string>} the new group's id */
  createGroup: async () => {
    const name = uniqueDefaultName(get().groups);
    const { id } = await homeApi.createGroup(name);
    set({ pendingRenameId: id });
    return id;
  },

  renameGroup: (id, name) => homeApi.renameGroup(id, name),

  deleteGroup: (id) => homeApi.deleteGroup(id),

  reorderGroups: (ids) => homeApi.reorderGroups(ids),

  assignTile: ({ tileId, groupId, index }) => homeApi.assignTile({ tileId, groupId, index }),

  setTileOverride: (patch) => homeApi.setTileOverride(patch),

  addManualTile: (tile) => homeApi.addManualTile(tile),

  updateManualTile: (id, patch) => homeApi.updateManualTile(id, patch),

  removeManualTile: (id) => homeApi.removeManualTile(id),

  clearPendingRenameId: () => set({ pendingRenameId: null }),
}));
