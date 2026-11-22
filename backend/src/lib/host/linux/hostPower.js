/**
 * Host power actions (shutdown, reboot) via wisp-power script.
 * Run through the privileged runner, as every helper.
 */
import { createAppError } from '../../appErrors.js';
import { runPrivileged, helperPath } from '../../base/index.js';

const POWER_UNAVAILABLE = 'POWER_UNAVAILABLE';
/** The helper bounds shutdown at 10 s (+2 to end): this ends after it. */
const POWER_TIMEOUT_MS = 15_000;

export async function hostShutdown() {
  try {
    await runPrivileged(helperPath('wisp-power'), ['shutdown'], { timeoutMs: POWER_TIMEOUT_MS });
    return { ok: true };
  } catch (err) {
    throw createAppError(POWER_UNAVAILABLE, `Shutdown failed (${err.reason ?? 'error'})`, err.detail ?? err.message);
  }
}

export async function hostReboot() {
  try {
    await runPrivileged(helperPath('wisp-power'), ['reboot'], { timeoutMs: POWER_TIMEOUT_MS });
    return { ok: true };
  } catch (err) {
    throw createAppError(POWER_UNAVAILABLE, `Reboot failed (${err.reason ?? 'error'})`, err.detail ?? err.message);
  }
}
