/**
 * Home page overlay: the sparse, human half of the launcher. Everything a tile
 * *is* (URL, backing workload, live state) is derived from workload data on
 * every read — this module owns only what a person decided: which groups exist,
 * which tile sits where, per-tile renames/icons/hides, and manually added links.
 *
 * Clones the sections pattern (`lib/sections.js`): every mutation goes through
 * `commitHomepage`, which persists under the settings write lock and then
 * announces the change so the `home` topic on /api/events re-pushes.
 */
import { randomUUID } from 'node:crypto';
import { createAppError } from './routeErrors.js';
import { withSettingsWriteLock, getRawHomepage, UNGROUPED_GROUP_ID } from './settings.js';

const MAX_NAME = 64;
const MAX_URL = 2048;

export { UNGROUPED_GROUP_ID };

/** Notified after every successful homepage write. No libvirt or containerd event
 *  can carry this — the `home` topic on /api/events is its only live signal. */
const homepageChangeHandlers = new Set();

export function subscribeHomepageChange(handler) {
  homepageChangeHandlers.add(handler);
  return () => homepageChangeHandlers.delete(handler);
}

/**
 * Persist a homepage change, then announce it. Every mutation below goes
 * through here rather than calling `withSettingsWriteLock` directly, so no
 * write can quietly skip the notification and strand a client on a stale page.
 * A mutator that throws (validation) rejects before any handler runs.
 */
async function commitHomepage(mutate) {
  await withSettingsWriteLock((fromFile) => {
    const homepage = fromFile.homepage || { groups: [], overrides: {}, manualTiles: [] };
    return { ...fromFile, homepage: mutate(homepage) };
  });
  for (const handler of homepageChangeHandlers) handler();
}

function validName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if (!name || name.length > MAX_NAME) return null;
  return name;
}

/**
 * Accept only absolute http/https URLs. Tiles are rendered as links the user
 * clicks, so anything else (javascript:, data:, a bare hostname) is refused at
 * the API boundary rather than sanitized later (CODING-RULES §9).
 */
function validUrl(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_URL) return null;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return trimmed;
}

function validTileId(raw) {
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  if (!id || id.length > MAX_URL) return null;
  return id;
}

/** The persisted overlay: `{ groups, overrides, manualTiles }`. */
export async function getHomepage() {
  return getRawHomepage();
}

export async function createHomeGroup(rawName) {
  const name = validName(rawName);
  if (!name) {
    throw createAppError('HOME_INVALID', 'Group name is required');
  }
  return commitHomepage((homepage) => {
    const exists = homepage.groups.some((g) => g.name.toLowerCase() === name.toLowerCase());
    if (exists) {
      throw createAppError('HOME_DUPLICATE', `A group named "${name}" already exists`);
    }
    return { ...homepage, groups: [...homepage.groups, { id: randomUUID(), name, tiles: [] }] };
  });
}

export async function renameHomeGroup(id, rawName) {
  const name = validName(rawName);
  if (!name) {
    throw createAppError('HOME_INVALID', 'Group name is required');
  }
  return commitHomepage((homepage) => {
    const idx = homepage.groups.findIndex((g) => g.id === id);
    if (idx < 0) {
      throw createAppError('HOME_NOT_FOUND', `No group with id "${id}"`);
    }
    const collide = homepage.groups.some(
      (g, i) => i !== idx && g.name.toLowerCase() === name.toLowerCase(),
    );
    if (collide) {
      throw createAppError('HOME_DUPLICATE', `A group named "${name}" already exists`);
    }
    const groups = [...homepage.groups];
    groups[idx] = { ...groups[idx], name };
    return { ...homepage, groups };
  });
}

/** Delete a group; its tiles fall back to Ungrouped on the next derivation. */
export async function deleteHomeGroup(id) {
  return commitHomepage((homepage) => {
    const groups = homepage.groups.filter((g) => g.id !== id);
    if (groups.length === homepage.groups.length) {
      throw createAppError('HOME_NOT_FOUND', `No group with id "${id}"`);
    }
    return { ...homepage, groups };
  });
}

/**
 * Replace the group ordering. The list must be a permutation of the current
 * groups (Ungrouped is implicit and never appears in the persisted array).
 */
export async function reorderHomeGroups(orderedIds) {
  if (!Array.isArray(orderedIds) || orderedIds.some((id) => typeof id !== 'string')) {
    throw createAppError('HOME_INVALID', 'ids must be an array of group ids');
  }
  return commitHomepage((homepage) => {
    const currentIds = new Set(homepage.groups.map((g) => g.id));
    const givenIds = new Set(orderedIds);
    if (orderedIds.length !== homepage.groups.length || givenIds.size !== orderedIds.length) {
      throw createAppError('HOME_INVALID', 'ids must list every group exactly once');
    }
    for (const id of orderedIds) {
      if (!currentIds.has(id)) {
        throw createAppError('HOME_NOT_FOUND', `No group with id "${id}"`);
      }
    }
    const byId = new Map(homepage.groups.map((g) => [g.id, g]));
    return { ...homepage, groups: orderedIds.map((id) => byId.get(id)) };
  });
}

/**
 * Place a tile in a group, optionally at a specific index. `groupId` of null
 * (or the implicit `ungrouped` id) drops the placement, returning the tile to
 * the Ungrouped bucket. Moving within the current group is how reordering
 * works — same call, new index.
 *
 * The tile itself isn't validated: placements are pure metadata, and a tile
 * that no longer derives is simply ignored on the next read.
 */
export async function assignTileToGroup({ tileId, groupId, index }) {
  const id = validTileId(tileId);
  if (!id) {
    throw createAppError('HOME_INVALID', 'tileId is required');
  }
  if (index != null && (!Number.isInteger(index) || index < 0)) {
    throw createAppError('HOME_INVALID', 'index must be a non-negative integer');
  }
  return commitHomepage((homepage) => {
    const target = !groupId || groupId === UNGROUPED_GROUP_ID ? null : groupId;
    if (target && !homepage.groups.some((g) => g.id === target)) {
      throw createAppError('HOME_NOT_FOUND', `No group with id "${target}"`);
    }
    const groups = homepage.groups.map((g) => ({
      ...g,
      tiles: g.tiles.filter((t) => t !== id),
    }));
    if (target) {
      const g = groups.find((x) => x.id === target);
      const at = index == null ? g.tiles.length : Math.min(index, g.tiles.length);
      g.tiles = [...g.tiles.slice(0, at), id, ...g.tiles.slice(at)];
    }
    return { ...homepage, groups };
  });
}

/**
 * Set (or clear) a tile's overrides. `null` clears one field; omitting a field
 * leaves it untouched. An override that ends up empty is deleted outright so
 * the config doesn't accumulate husks.
 */
export async function setTileOverride({ tileId, hidden, name, iconId }) {
  const id = validTileId(tileId);
  if (!id) {
    throw createAppError('HOME_INVALID', 'tileId is required');
  }
  if (hidden !== undefined && hidden !== null && typeof hidden !== 'boolean') {
    throw createAppError('HOME_INVALID', 'hidden must be a boolean');
  }
  if (name !== undefined && name !== null && validName(name) === null) {
    throw createAppError('HOME_INVALID', `name must be 1–${MAX_NAME} characters`);
  }
  return commitHomepage((homepage) => {
    const current = homepage.overrides[id] || {};
    const next = { ...current };
    if (hidden !== undefined) {
      if (hidden === true) next.hidden = true;
      else delete next.hidden;
    }
    if (name !== undefined) {
      if (name === null) delete next.name;
      else next.name = validName(name);
    }
    if (iconId !== undefined) {
      if (iconId === null || iconId === '') delete next.iconId;
      else if (typeof iconId !== 'string') {
        throw createAppError('HOME_INVALID', 'iconId must be a string or null');
      } else next.iconId = iconId.trim();
    }
    const overrides = { ...homepage.overrides };
    if (Object.keys(next).length) overrides[id] = next;
    else delete overrides[id];
    return { ...homepage, overrides };
  });
}

export async function addManualTile({ name, url, iconId }) {
  const tileName = validName(name);
  if (!tileName) {
    throw createAppError('HOME_INVALID', 'name is required');
  }
  const tileUrl = validUrl(url);
  if (!tileUrl) {
    throw createAppError('HOME_INVALID', 'url must be an absolute http or https URL');
  }
  return commitHomepage((homepage) => ({
    ...homepage,
    manualTiles: [
      ...homepage.manualTiles,
      {
        id: randomUUID(),
        name: tileName,
        url: tileUrl,
        iconId: typeof iconId === 'string' && iconId.trim() ? iconId.trim() : null,
      },
    ],
  }));
}

export async function updateManualTile(id, { name, url, iconId }) {
  return commitHomepage((homepage) => {
    const idx = homepage.manualTiles.findIndex((t) => t.id === id);
    if (idx < 0) {
      throw createAppError('HOME_NOT_FOUND', `No manual tile with id "${id}"`);
    }
    const next = { ...homepage.manualTiles[idx] };
    if (name !== undefined) {
      const tileName = validName(name);
      if (!tileName) {
        throw createAppError('HOME_INVALID', 'name is required');
      }
      next.name = tileName;
    }
    if (url !== undefined) {
      const tileUrl = validUrl(url);
      if (!tileUrl) {
        throw createAppError('HOME_INVALID', 'url must be an absolute http or https URL');
      }
      next.url = tileUrl;
    }
    if (iconId !== undefined) {
      next.iconId = typeof iconId === 'string' && iconId.trim() ? iconId.trim() : null;
    }
    const manualTiles = [...homepage.manualTiles];
    manualTiles[idx] = next;
    return { ...homepage, manualTiles };
  });
}

/** Remove a manual tile along with its group placement and overrides. */
export async function removeManualTile(id) {
  return commitHomepage((homepage) => {
    const manualTiles = homepage.manualTiles.filter((t) => t.id !== id);
    if (manualTiles.length === homepage.manualTiles.length) {
      throw createAppError('HOME_NOT_FOUND', `No manual tile with id "${id}"`);
    }
    const overrides = { ...homepage.overrides };
    delete overrides[id];
    return {
      ...homepage,
      manualTiles,
      overrides,
      groups: homepage.groups.map((g) => ({ ...g, tiles: g.tiles.filter((t) => t !== id) })),
    };
  });
}
