/**
 * Centralized I/O for container.json. All mutations go through writeContainerConfig
 * so list-change notifications (and any future schema validation, atomic writes, etc.)
 * have one place to live.
 */
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

import { containerError } from './containerManagerConnection.js';
import { getContainerDir } from './containerPaths.js';

const listChangeHandlers = new Set();

export async function readContainerConfig(name) {
  const path = join(getContainerDir(name), 'container.json');
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw containerError('CONTAINER_NOT_FOUND', `Container "${name}" not found`);
  }
  return JSON.parse(raw);
}

export async function writeContainerConfig(name, config) {
  const path = join(getContainerDir(name), 'container.json');
  await writeFile(path, JSON.stringify(config, null, 2));
  fireListChange(name);
}

export function subscribeContainerListChange(handler) {
  listChangeHandlers.add(handler);
  return () => listChangeHandlers.delete(handler);
}

function fireListChange(name) {
  for (const h of listChangeHandlers) {
    try { h(name); } catch (err) { console.warn('[containerManager] list-change handler threw:', err?.message || err); }
  }
}
