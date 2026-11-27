/**
 * The shape of an env change (`envPatch`: `{ KEY: { value?, secret? } | null }`),
 * checked before anything is written: a key that trims to nothing, an entry
 * that is not an object or null, a value that is not a string, a secret flag
 * that is not a boolean. Pure: the macOS stub checks the same.
 */
import { containerError } from '../containerManagerShared.js';

export function validateEnvPatch(envPatch) {
  if (!envPatch || typeof envPatch !== 'object' || Array.isArray(envPatch)) {
    throw containerError('CONFIG_ERROR', 'envPatch must be an object');
  }
  for (const [rawKey, entry] of Object.entries(envPatch)) {
    const key = rawKey.trim();
    if (!key) {
      throw containerError('CONFIG_ERROR', 'envPatch keys must be non-empty strings');
    }
    if (entry === null) continue;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw containerError('CONFIG_ERROR', `envPatch entry for "${key}" must be an object or null`);
    }
    if ('value' in entry && entry.value != null && typeof entry.value !== 'string') {
      throw containerError('CONFIG_ERROR', `envPatch value for "${key}" must be a string`);
    }
    if ('secret' in entry && typeof entry.secret !== 'boolean') {
      throw containerError('CONFIG_ERROR', `envPatch secret flag for "${key}" must be boolean`);
    }
  }
}
