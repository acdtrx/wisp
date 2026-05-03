import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import { createAppError } from '../../routeErrors.js';

const execFileAsync = promisify(execFileCb);

const SCRIPT_PATH = '/usr/local/bin/wisp-os-update';

const UNAVAILABLE = 'UPDATE_CHECK_UNAVAILABLE';

/** Cached count of upgradable packages; set by background hourly check. */
let cachedUpdateCount = 0;

/** ISO timestamp of the last successful update check (background or manual). */
let cachedLastCheckedAt = null;

export function getPendingUpdatesCount() {
  return cachedUpdateCount;
}

export function setCachedUpdateCount(count) {
  cachedUpdateCount = count;
}

export function getLastCheckedAt() {
  return cachedLastCheckedAt;
}

async function getScriptPath() {
  try {
    await access(SCRIPT_PATH);
  } catch (err) {
    throw createAppError(UNAVAILABLE, 'wisp-os-update script not found or not readable', err.message);
  }
  return SCRIPT_PATH;
}

/**
 * @param {AbortSignal} [signal] - When aborted (e.g. process shutdown), the child process is killed.
 */
async function runUpdateScript(scriptPath, action, timeoutMs, signal) {
  const isRoot = process.getuid && process.getuid() === 0;
  const opts = { timeout: timeoutMs };
  if (signal) opts.signal = signal;

  try {
    if (isRoot) {
      return await execFileAsync(scriptPath, [action], opts);
    }
    return await execFileAsync('sudo', ['-n', scriptPath, action], opts);
  } catch (err) {
    if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
      throw err;
    }
    const detail = err.stderr || err.stdout || err.message;
    throw createAppError(UNAVAILABLE, `OS update ${action} failed (privilege or package manager error)`, detail?.trim() || err.message);
  }
}

/**
 * Sync package database and count upgradable packages.
 * Supports Debian/Ubuntu (apt) and Arch Linux (pacman) via wisp-os-update.
 * @param {AbortSignal} [signal]
 * @returns { Promise<{ count: number }> }
 * @throws {{ code: 'UPDATE_CHECK_UNAVAILABLE', message: string, detail?: string }}
 */
export async function checkForUpdates(signal) {
  const scriptPath = await getScriptPath();
  const { stdout } = await runUpdateScript(scriptPath, 'check', 120000, signal);

  const count = parseInt(String(stdout).trim(), 10);
  const result = { count: Number.isNaN(count) || count < 0 ? 0 : count };
  cachedLastCheckedAt = new Date().toISOString();
  return result;
}

/**
 * Sync package database and perform a full non-interactive upgrade.
 * Supports Debian/Ubuntu (apt) and Arch Linux (pacman) via wisp-os-update.
 * @param {AbortSignal} [signal]
 * @returns { Promise<{ ok: true }> }
 * @throws {{ code: 'UPDATE_CHECK_UNAVAILABLE', message: string, detail?: string }}
 */
export async function performUpgrade(signal) {
  const scriptPath = await getScriptPath();
  await runUpdateScript(scriptPath, 'upgrade', 600000, signal);
  return { ok: true };
}

/**
 * Sync package database and parse the structured upgradable-package list.
 * Output contract from wisp-os-update list:
 *   PKG<TAB>name<TAB>from<TAB>to    (one line per package)
 *   TOTAL <bytes>                   (total download size; 0 if unknown)
 * @param {AbortSignal} [signal]
 * @returns { Promise<{ packages: Array<{ name: string, from: string|null, to: string }>, downloadBytes: number }> }
 * @throws {{ code: 'UPDATE_CHECK_UNAVAILABLE', message: string, detail?: string }}
 */
export async function listUpgradablePackages(signal) {
  const scriptPath = await getScriptPath();
  const { stdout } = await runUpdateScript(scriptPath, 'list', 120000, signal);
  const packages = [];
  let downloadBytes = 0;
  for (const line of String(stdout).split('\n')) {
    if (line.startsWith('PKG\t')) {
      const [, name, from, to] = line.split('\t');
      if (name && to) {
        packages.push({ name, from: from || null, to });
      }
    } else if (line.startsWith('TOTAL ')) {
      const n = parseInt(line.slice(6).trim(), 10);
      if (Number.isFinite(n) && n > 0) downloadBytes = n;
    }
  }
  cachedLastCheckedAt = new Date().toISOString();
  cachedUpdateCount = packages.length;
  return { packages, downloadBytes };
}

const INITIAL_DELAY_MS = 30_000;
const INTERVAL_MS = 60 * 60 * 1000; // 1 hour

let intervalId = null;
let initialTimeoutId = null;

/** AbortController for the in-flight background `check` subprocess (must be killed on SIGTERM). */
let activeBackgroundCheckAbort = null;

/**
 * Start background hourly update check. First check after INITIAL_DELAY_MS.
 * Safe to call multiple times; only starts once.
 * @param { { warn: (o: object, msg: string) => void } } [log] - Optional logger for warnings
 */
export function startUpdateChecker(log) {
  if (intervalId != null) return;

  function runCheck() {
    const ac = new AbortController();
    activeBackgroundCheckAbort = ac;
    checkForUpdates(ac.signal)
      .then(({ count }) => setCachedUpdateCount(count))
      .catch((err) => {
        if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') return;
        if (log) log.warn({ err }, 'Background update check failed');
      })
      .finally(() => {
        if (activeBackgroundCheckAbort === ac) {
          activeBackgroundCheckAbort = null;
        }
      });
  }

  initialTimeoutId = setTimeout(() => {
    initialTimeoutId = null;
    runCheck();
  }, INITIAL_DELAY_MS);
  intervalId = setInterval(runCheck, INTERVAL_MS);
}

/**
 * Clear background timers and abort any running wisp-os-update check so the process can exit on SIGTERM.
 */
export function stopUpdateChecker() {
  if (initialTimeoutId != null) {
    clearTimeout(initialTimeoutId);
    initialTimeoutId = null;
  }
  if (intervalId != null) {
    clearInterval(intervalId);
    intervalId = null;
  }
  if (activeBackgroundCheckAbort != null) {
    try {
      activeBackgroundCheckAbort.abort();
    } catch {
      // AbortController.abort is synchronous; ignore edge cases
    }
    activeBackgroundCheckAbort = null;
  }
}
