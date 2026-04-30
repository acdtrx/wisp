import { randomUUID } from 'node:crypto';
import { createAppError } from './routeErrors.js';
import { withSettingsWriteLock, MAIN_SECTION_ID, getSettings } from './settings.js';

const MAX_NAME = 64;
const VALID_TYPES = new Set(['vm', 'container']);

function assignmentKey(type, name) {
  return `${type}:${name}`;
}

function validName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if (!name || name.length > MAX_NAME) return null;
  return name;
}

/**
 * Public sections list including the synthetic "Main" section first.
 * Main is never persisted; its id is the constant MAIN_SECTION_ID.
 */
export async function listSections() {
  const s = await getSettings();
  const sections = s.sections || [];
  return [
    { id: MAIN_SECTION_ID, name: 'Main', order: -Infinity, builtin: true },
    ...sections.map((x) => ({ ...x, builtin: false })),
  ];
}

export async function getAssignments() {
  const s = await getSettings();
  return s.assignments || {};
}

/**
 * Resolve a workload's section id, falling back to Main when no assignment
 * exists or the assignment points at a section that no longer exists.
 * The assignments map is normalized on read, so a missing key always means
 * the workload should land in Main.
 */
export function resolveSectionId(assignments, type, name) {
  const key = assignmentKey(type, name);
  const id = assignments && assignments[key];
  return id || MAIN_SECTION_ID;
}

export async function createSection(rawName) {
  const name = validName(rawName);
  if (!name) {
    throw createAppError('SECTION_INVALID', 'Section name is required');
  }
  return withSettingsWriteLock((fromFile) => {
    const sections = fromFile.sections || [];
    const exists = sections.some((s) => s.name.toLowerCase() === name.toLowerCase());
    if (exists) {
      throw createAppError('SECTION_DUPLICATE', `A section named "${name}" already exists`);
    }
    const maxOrder = sections.reduce((m, s) => Math.max(m, s.order ?? 0), -1);
    const next = { id: randomUUID(), name, order: maxOrder + 1 };
    return { ...fromFile, sections: [...sections, next] };
  });
}

export async function renameSection(id, rawName) {
  if (id === MAIN_SECTION_ID) {
    throw createAppError('SECTION_INVALID', 'The Main section cannot be renamed');
  }
  const name = validName(rawName);
  if (!name) {
    throw createAppError('SECTION_INVALID', 'Section name is required');
  }
  return withSettingsWriteLock((fromFile) => {
    const sections = fromFile.sections || [];
    const idx = sections.findIndex((s) => s.id === id);
    if (idx < 0) {
      throw createAppError('SECTION_NOT_FOUND', `No section with id "${id}"`);
    }
    const collide = sections.some(
      (s, i) => i !== idx && s.name.toLowerCase() === name.toLowerCase(),
    );
    if (collide) {
      throw createAppError('SECTION_DUPLICATE', `A section named "${name}" already exists`);
    }
    const list = [...sections];
    list[idx] = { ...list[idx], name };
    return { ...fromFile, sections: list };
  });
}

/**
 * Replace the persisted ordering with the given list of ids. The list must be
 * a permutation of the current user-defined sections (Main is implicit and
 * never appears in the persisted array). After validation we reassign every
 * section's `order` to its index in `orderedIds` so the result is canonical
 * (no stale gaps or duplicate values).
 */
export async function reorderSections(orderedIds) {
  if (!Array.isArray(orderedIds) || orderedIds.some((id) => typeof id !== 'string')) {
    throw createAppError('SECTION_INVALID', 'orderedIds must be an array of section ids');
  }
  return withSettingsWriteLock((fromFile) => {
    const sections = fromFile.sections || [];
    const currentIds = new Set(sections.map((s) => s.id));
    const givenIds = new Set(orderedIds);
    if (orderedIds.length !== sections.length || givenIds.size !== orderedIds.length) {
      throw createAppError('SECTION_INVALID', 'orderedIds must list every section exactly once');
    }
    for (const id of orderedIds) {
      if (!currentIds.has(id)) {
        throw createAppError('SECTION_NOT_FOUND', `No section with id "${id}"`);
      }
    }
    const byId = new Map(sections.map((s) => [s.id, s]));
    const next = orderedIds.map((id, index) => ({ ...byId.get(id), order: index }));
    return { ...fromFile, sections: next };
  });
}

export async function deleteSection(id) {
  if (id === MAIN_SECTION_ID) {
    throw createAppError('SECTION_INVALID', 'The Main section cannot be deleted');
  }
  return withSettingsWriteLock((fromFile) => {
    const sections = fromFile.sections || [];
    const next = sections.filter((s) => s.id !== id);
    if (next.length === sections.length) {
      throw createAppError('SECTION_NOT_FOUND', `No section with id "${id}"`);
    }
    /* Drop assignments pointing at this section so the workloads fall back
     * to Main on next read. The assignment normalizer in settings.js would
     * also strip them, but doing it here keeps writes minimal. */
    const oldAssign = fromFile.assignments || {};
    const newAssign = {};
    for (const [k, v] of Object.entries(oldAssign)) {
      if (v !== id) newAssign[k] = v;
    }
    return { ...fromFile, sections: next, assignments: newAssign };
  });
}

/**
 * Move a workload to a section. `sectionId === MAIN_SECTION_ID` (or null)
 * means "drop the assignment". Other ids must match an existing section.
 * The workload itself isn't validated here — assignments are pure metadata
 * and a missing workload is a no-op (the entry is simply ignored next read).
 */
export async function assignWorkload({ type, name, sectionId }) {
  if (!VALID_TYPES.has(type)) {
    throw createAppError('SECTION_INVALID', `type must be "vm" or "container"`);
  }
  const wname = validName(name);
  if (!wname) {
    throw createAppError('SECTION_INVALID', 'workload name is required');
  }
  return withSettingsWriteLock((fromFile) => {
    const sections = fromFile.sections || [];
    const assign = { ...(fromFile.assignments || {}) };
    const key = assignmentKey(type, wname);
    if (!sectionId || sectionId === MAIN_SECTION_ID) {
      delete assign[key];
    } else {
      const exists = sections.some((s) => s.id === sectionId);
      if (!exists) {
        throw createAppError('SECTION_NOT_FOUND', `No section with id "${sectionId}"`);
      }
      assign[key] = sectionId;
    }
    return { ...fromFile, assignments: assign };
  });
}
