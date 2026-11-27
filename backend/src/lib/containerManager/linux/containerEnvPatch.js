/**
 * The shape of an env change (`{ KEY: { value?, secret? } | null }`: a PATCH's
 * `envPatch`, a deploy's env), checked before anything is written, its
 * messages about env variables, as either caller reads them: a key that trims to nothing, an entry
 * that is not an object or null, a value that is not a string, a secret flag
 * that is not a boolean. Pure: the macOS stub checks the same.
 */
import { containerError } from '../containerManagerShared.js';

export function validateEnvPatch(envPatch) {
  if (!envPatch || typeof envPatch !== 'object' || Array.isArray(envPatch)) {
    throw containerError('CONFIG_ERROR', 'The env change must be an object of env variables');
  }
  for (const [rawKey, entry] of Object.entries(envPatch)) {
    const key = rawKey.trim();
    if (!key) {
      throw containerError('CONFIG_ERROR', 'An env variable needs a name: an empty one, or one of spaces only, is refused');
    }
    if (entry === null) continue;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw containerError('CONFIG_ERROR', `Env variable "${key}": give it as { value, secret }, or null to remove it`);
    }
    if ('value' in entry && entry.value != null && typeof entry.value !== 'string') {
      throw containerError('CONFIG_ERROR', `Env variable "${key}": its value must be a string`);
    }
    if ('secret' in entry && typeof entry.secret !== 'boolean') {
      throw containerError('CONFIG_ERROR', `Env variable "${key}": its secret flag must be true or false`);
    }
  }
}
