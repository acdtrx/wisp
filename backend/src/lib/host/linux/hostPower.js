/**
 * Host power actions (shutdown, reboot) via wisp-power script.
 * Same sudo pattern as wisp-os-update.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { access } from 'node:fs/promises';
import { createAppError } from '../../appErrors.js';
import { runPrivileged } from '../../base/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Prefer installed helper + sudoers path (installed by setup's helpers step); bundled path for dev. */
const POWER_INSTALLED = '/usr/local/bin/wisp-power';
const POWER_BUNDLED = resolve(__dirname, '../../../../scripts/wisp-power');
const POWER_UNAVAILABLE = 'POWER_UNAVAILABLE';

async function getScriptPath() {
  const fromEnv = process.env.WISP_POWER_SCRIPT;
  if (fromEnv) {
    try {
      await access(fromEnv);
      return fromEnv;
    } catch (err) {
      throw createAppError(POWER_UNAVAILABLE, 'wisp-power script not found or not readable', err.message);
    }
  }
  for (const p of [POWER_INSTALLED, POWER_BUNDLED]) {
    try {
      await access(p);
      return p;
    } catch {
      /* try next */
    }
  }
  throw createAppError(
    POWER_UNAVAILABLE,
    'wisp-power script not found or not readable',
    'Set WISP_POWER_SCRIPT or run setup (scripts/linux/setup/common-steps.sh installs the helper to /usr/local/bin)'
  );
}

export async function hostShutdown() {
  const scriptPath = await getScriptPath();
  try {
    await runPrivileged(scriptPath, ['shutdown'], { timeoutMs: 5000 });
    return { ok: true };
  } catch (err) {
    throw createAppError(POWER_UNAVAILABLE, `Shutdown failed (${err.reason ?? 'error'})`, err.detail ?? err.message);
  }
}

export async function hostReboot() {
  const scriptPath = await getScriptPath();
  try {
    await runPrivileged(scriptPath, ['reboot'], { timeoutMs: 5000 });
    return { ok: true };
  } catch (err) {
    throw createAppError(POWER_UNAVAILABLE, `Reboot failed (${err.reason ?? 'error'})`, err.detail ?? err.message);
  }
}
