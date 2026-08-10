import { create } from 'zustand';
import * as homeApi from '../api/homepage.js';
import { subscribeTopic } from '../api/events.js';

export const UNGROUPED_GROUP_ID = 'ungrouped';

function applyResponse(set, response) {
  if (!response || !Array.isArray(response.tiles) || !Array.isArray(response.groups)) {
    return response;
  }
  set({ tiles: response.tiles, groups: response.groups, loaded: true });
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
  /* Set after a group is created so the matching header opens its rename input
   * on first render, then clears it — same flow as the sidebar's new section. */
  pendingRenameId: null,

  startHomeSSE: () => {
    if (homeCloseFn) return;
    homeCloseFn = subscribeTopic('home', (data) => {
      if (!data || !Array.isArray(data.tiles)) return; // error frame; keep the last good envelope
      applyResponse(set, data);
    });
  },

  stopHomeSSE: () => {
    if (homeCloseFn) {
      homeCloseFn();
      homeCloseFn = null;
    }
  },

  createGroup: async () => {
    const name = uniqueDefaultName(get().groups);
    const response = await homeApi.createGroup(name);
    applyResponse(set, response);
    const created = (response.groups || []).find(
      (g) => g.name.toLowerCase() === name.toLowerCase(),
    );
    if (created) set({ pendingRenameId: created.id });
  },

  renameGroup: async (id, name) => applyResponse(set, await homeApi.renameGroup(id, name)),

  deleteGroup: async (id) => applyResponse(set, await homeApi.deleteGroup(id)),

  reorderGroups: async (ids) => applyResponse(set, await homeApi.reorderGroups(ids)),

  assignTile: async ({ tileId, groupId, index }) =>
    applyResponse(set, await homeApi.assignTile({ tileId, groupId, index })),

  setTileOverride: async (patch) => applyResponse(set, await homeApi.setTileOverride(patch)),

  addManualTile: async (tile) => applyResponse(set, await homeApi.addManualTile(tile)),

  updateManualTile: async (id, patch) =>
    applyResponse(set, await homeApi.updateManualTile(id, patch)),

  removeManualTile: async (id) => applyResponse(set, await homeApi.removeManualTile(id)),

  clearPendingRenameId: () => set({ pendingRenameId: null }),
}));
