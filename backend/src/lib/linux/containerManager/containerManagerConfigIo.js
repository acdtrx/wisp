/**
 * Centralized I/O for container.json. All mutations go through writeContainerConfig
 * so config-write notifications (and any future schema validation, atomic writes, etc.)
 * have one place to live.
 */
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

import { containerError } from './containerManagerConnection.js';
import { getContainerDir } from './containerPaths.js';

const configWriteHandlers = new Set();

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
  notifyContainerConfigWrite(name);
}

export function subscribeContainerConfigWrite(handler) {
  configWriteHandlers.add(handler);
  return () => configWriteHandlers.delete(handler);
}

export function notifyContainerConfigWrite(name) {
  for (const h of configWriteHandlers) {
    try { h(name); } catch (err) { console.warn('[containerManager] config-write handler threw:', err?.message || err); }
  }
}
