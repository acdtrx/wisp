import { create } from 'zustand';
import * as homeApi from '../api/homepage.js';
import { sendAndAwaitTopic, subscribeTopic } from '../api/events.js';
import { errorText } from '../api/errors.js';

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

const onHomeTopic = (send) => sendAndAwaitTopic('home', send);

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
        set({ loadError: errorText(data) }); // keep the last good envelope
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

  /* Writes answer with an ack; each resolves once the new envelope has arrived on
   * the `home` topic too. */

  /** Create a group with a default name and flag it for rename: its header opens
   *  the rename input when it first renders, whenever the topic brings it.
   *  @returns {Promise<string>} the new group's id */
  createGroup: async () => {
    const name = uniqueDefaultName(get().groups);
    const { id } = await onHomeTopic(() => homeApi.createGroup(name));
    set({ pendingRenameId: id });
    return id;
  },

  renameGroup: (id, name) => onHomeTopic(() => homeApi.renameGroup(id, name)),

  deleteGroup: (id) => onHomeTopic(() => homeApi.deleteGroup(id)),

  reorderGroups: (ids) => onHomeTopic(() => homeApi.reorderGroups(ids)),

  assignTile: ({ tileId, groupId, index }) =>
    onHomeTopic(() => homeApi.assignTile({ tileId, groupId, index })),

  setTileOverride: (patch) => onHomeTopic(() => homeApi.setTileOverride(patch)),

  addManualTile: (tile) => onHomeTopic(() => homeApi.addManualTile(tile)),

  updateManualTile: (id, patch) => onHomeTopic(() => homeApi.updateManualTile(id, patch)),

  removeManualTile: (id) => onHomeTopic(() => homeApi.removeManualTile(id)),

  clearPendingRenameId: () => set({ pendingRenameId: null }),
}));
