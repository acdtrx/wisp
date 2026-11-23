/**
 * The one way the storage module runs the `wisp-mount` helper: a missing
 * helper is the caller's own `unavailableCode`, every other failure is the
 * runner's error as it came.
 */
import { createAppError } from '../../appErrors.js';
import { runPrivileged, helperPath } from '../../base/index.js';

export async function runWispMount(args, timeoutMs, unavailableCode) {
  try {
    return await runPrivileged(helperPath('wisp-mount'), args, { timeoutMs });
  } catch (err) {
    if (err.reason === 'missing') throw createAppError(unavailableCode, 'wisp-mount script not found or not readable', err.message);
    throw err;
  }
}
