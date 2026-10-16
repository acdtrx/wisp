/**
 * Centralized I/O for container.json. All mutations go through writeContainerConfig
 * so config-write notifications (and any future schema validation, atomic writes, etc.)
 * have one place to live.
 */
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { containerError, containerState } from './containerManagerConnection.js';
import { getContainerDir } from './containerPaths.js';
import { writeJsonAtomic } from './atomicJson.js';

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

/* Secret env values (and app secrets such as API tokens) sit in plaintext in
 * container.json, so it is owner-only. Every write is a fresh file renamed
 * into place, so every write applies the mode. */
const CONTAINER_CONFIG_MODE = 0o600;

export async function writeContainerConfig(name, config) {
  const path = join(getContainerDir(name), 'container.json');
  await writeJsonAtomic(path, config, { mode: CONTAINER_CONFIG_MODE });
  notifyContainerConfigWrite(name);
}

export function subscribeContainerConfigWrite(handler) {
  configWriteHandlers.add(handler);
  return () => configWriteHandlers.delete(handler);
}

export function notifyContainerConfigWrite(name) {
  for (const h of configWriteHandlers) {
    try { h(name); } catch (err) { containerState.logger?.warn?.({ err: err?.message || err }, '[containerManager] config-write handler threw'); }
  }
}
