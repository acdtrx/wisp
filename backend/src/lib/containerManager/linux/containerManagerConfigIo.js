/**
 * Centralized I/O for container.json. All mutations go through writeContainerConfig
 * so config-write notifications (and any future schema validation, atomic writes, etc.)
 * have one place to live.
 */
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { containerError, containerState, wrapContainerError } from './containerManagerConnection.js';
import { getContainerDir } from './containerPaths.js';
import { writeJsonAtomic } from './atomicJson.js';
import { createEmitter } from '../../base/index.js';

const configWrite = createEmitter('[containerManager] config-write', () => containerState.logger);

/**
 * The one read of a `container.json`, at `path`: CONTAINER_NOT_FOUND when it
 * does not exist, INTERNAL_ERROR when it cannot be read, PARSE_ERROR when it is
 * not a JSON object. `name` is the container it belongs to, for the messages.
 * Writes are atomic (writeJsonAtomic), so a half-written file is never read.
 */
export async function readContainerConfigFile(path, name) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      throw containerError('CONTAINER_NOT_FOUND', `Container "${name}" not found`);
    }
    throw wrapContainerError('INTERNAL_ERROR', `Cannot read the configuration of container "${name}"`, err);
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    throw wrapContainerError('PARSE_ERROR', `The configuration of container "${name}" is not valid JSON`, err);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw containerError('PARSE_ERROR', `The configuration of container "${name}" is not a JSON object`);
  }
  return config;
}

/** A container's `container.json` (readContainerConfigFile's answers). */
export function readContainerConfig(name) {
  return readContainerConfigFile(join(getContainerDir(name), 'container.json'), name);
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

export const subscribeContainerConfigWrite = configWrite.subscribe;

export function notifyContainerConfigWrite(name) {
  configWrite.emit(name);
}
