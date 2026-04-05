/**
 * Host power actions (shutdown, reboot) via wisp-power script.
 * Same sudo pattern as wisp-os-update.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { access } from 'node:fs/promises';
import { createAppError } from '../../routeErrors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

/** Prefer installed helper + sudoers path (see setup-server.sh); bundled path for dev. */
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
    'Set WISP_POWER_SCRIPT or install via setup-server.sh (helper to /usr/local/bin)'
  );
}

export async function hostShutdown() {
  const scriptPath = await getScriptPath();
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  try {
    if (isRoot) {
      await execFileAsync(scriptPath, ['shutdown'], { timeout: 5000 });
    } else {
      await execFileAsync('sudo', ['-n', scriptPath, 'shutdown'], { timeout: 5000 });
    }
    return { ok: true };
  } catch (err) {
    const detail = err.stderr || err.stdout || err.message;
    throw createAppError(POWER_UNAVAILABLE, 'Shutdown failed (privilege or script error)', detail?.trim() || err.message);
  }
}

export async function hostReboot() {
  const scriptPath = await getScriptPath();
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  try {
    if (isRoot) {
      await execFileAsync(scriptPath, ['reboot'], { timeout: 5000 });
    } else {
      await execFileAsync('sudo', ['-n', scriptPath, 'reboot'], { timeout: 5000 });
    }
    return { ok: true };
  } catch (err) {
    const detail = err.stderr || err.stdout || err.message;
    throw createAppError(POWER_UNAVAILABLE, 'Reboot failed (privilege or script error)', detail?.trim() || err.message);
  }
}
