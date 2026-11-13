import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createAppError } from '../../routeErrors.js';
import { createStallWatchdog, stallMinutes } from '../../storage/index.js';

const SCRIPT_PATH = '/usr/local/bin/wisp-os-update';

const UNAVAILABLE = 'UPDATE_CHECK_UNAVAILABLE';
const BUSY = 'UPDATE_BUSY';

/** Cached count of upgradable packages; updated on every successful list. */
let cachedUpdateCount = 0;

/** ISO timestamp of the last successful update check (background or manual). */
let cachedLastCheckedAt = null;

/** Cached package list from the most recent successful list op (null = no cache). */
let cachedPackages = null;
let cachedDownloadBytes = 0;
let cachedPackagesAt = null;

/**
 * In-flight read op (check/list share a single apt invocation under the hood).
 * Concurrent callers reuse the same promise instead of spawning a second apt.
 */
let inflightRead = null;

/** In-flight upgrade op. Mutually exclusive with reads — apt holds the dpkg lock. */
let inflightUpgrade = null;

export function getPendingUpdatesCount() {
  return cachedUpdateCount;
}

export function getLastCheckedAt() {
  return cachedLastCheckedAt;
}

/** Read-only snapshot of the cached package list, or null if never fetched. */
export function getCachedPackages() {
  if (cachedPackages == null) return null;
  return {
    packages: cachedPackages,
    downloadBytes: cachedDownloadBytes,
    lastCheckedAt: cachedPackagesAt,
  };
}

/** True when an apt subprocess is in flight (either kind). */
export function isOperationInProgress() {
  return inflightRead != null || inflightUpgrade != null;
}

async function getScriptPath() {
  try {
    await access(SCRIPT_PATH);
  } catch (err) {
    throw createAppError(UNAVAILABLE, 'wisp-os-update script not found or not readable', err.message);
  }
  return SCRIPT_PATH;
}

/*
 * Bounds (CODING-RULES §6; contracts in docs/specs/HOST-MONITORING.md § OS
 * Updates): the helper passes apt/pacman's output through on stderr, and the
 * run is stopped after this long without any of it. `list` gets 90 s — above
 * the helper's own per-step bounds (60 s each), which stop a hung step first;
 * `upgrade` 15 min, since dkms and initramfs builds can be silent for minutes.
 */
const LIST_IDLE_MS = 90_000;
const UPGRADE_IDLE_MS = 15 * 60_000;
const STDERR_KEEP = 64 * 1024;

/**
 * Run wisp-os-update `action` (through sudo unless root), stopped after
 * `idleMs` without output. `onLine(text)` gets each non-empty output line
 * (progress). Resolves `{ stdout, stderr }`.
 * @param {AbortSignal} [signal] - When aborted (e.g. process shutdown), the child process is killed.
 */
function runUpdateScript(scriptPath, action, { idleMs, signal, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const isRoot = process.getuid && process.getuid() === 0;
    /* stdin is /dev/null: anything in the apt/dpkg/pacman chain that reads a
     * prompt answer gets EOF instead of waiting forever. */
    const child = isRoot
      ? spawn(scriptPath, [action], { stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn('sudo', ['-n', scriptPath, action], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let partial = '';
    let killTimer = null;
    const stop = () => {
      child.kill('SIGTERM'); // sudo relays it; the helper stops its step's child
      killTimer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    };
    const watchdog = createStallWatchdog({ stallMs: idleMs, onStall: stop });
    const onAbort = () => stop();
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { watchdog.poke(); stdout += d; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      watchdog.poke();
      stderr = (stderr + d).slice(-STDERR_KEEP);
      if (!onLine) return;
      const lines = (partial + d).split(/\r?\n/);
      partial = lines.pop();
      for (const line of lines) if (line.trim()) onLine(line.trim());
    });
    child.on('error', (err) => {
      watchdog.stop();
      reject(createAppError(UNAVAILABLE, `OS update ${action} failed to start`, err.message));
    });
    child.on('close', (code) => {
      watchdog.stop();
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' }));
      } else if (watchdog.fired) {
        reject(createAppError(UNAVAILABLE, `OS update ${action} printed nothing for ${stallMinutes(idleMs)} and was stopped`, stderr.trim().split('\n').slice(-5).join('\n')));
      } else if (code === 0) {
        resolve({ stdout, stderr });
      } else if (code === 75) {
        /* EX_TEMPFAIL: another apt/dpkg/pacman process holds the package-manager lock. */
        reject(createAppError(BUSY, 'Another package manager operation is running on the host', stderr.trim().split('\n').slice(-5).join('\n') || 'package manager lock held by another process'));
      } else {
        reject(createAppError(UNAVAILABLE, `OS update ${action} failed (privilege or package manager error)`, stderr.trim().split('\n').slice(-20).join('\n') || `exit ${code}`));
      }
    });
  });
}

/**
 * Run the `list` op against wisp-os-update and parse its structured output.
 * Always exposed via `runListShared` (which adds caching + dedup); never call
 * directly except from there.
 */
async function runListOp(signal) {
  const scriptPath = await getScriptPath();
  const { stdout } = await runUpdateScript(scriptPath, 'list', { idleMs: LIST_IDLE_MS, signal });
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
  return { packages, downloadBytes };
}

/**
 * Shared driver for both `checkForUpdates` and `listUpgradablePackages`.
 * - If an upgrade is in flight, throws UPDATE_BUSY (apt is exclusively locked).
 * - If a read is already in flight, returns the same promise (dedup).
 * - Otherwise spawns one subprocess and updates all caches on success.
 */
function runListShared(signal) {
  if (inflightUpgrade) {
    return Promise.reject(
      createAppError(BUSY, 'An OS upgrade is in progress on the host', 'Wait for the upgrade to finish before checking again'),
    );
  }
  if (inflightRead) return inflightRead;

  const promise = runListOp(signal)
    .then((result) => {
      const now = new Date().toISOString();
      cachedUpdateCount = result.packages.length;
      cachedLastCheckedAt = now;
      cachedPackages = result.packages;
      cachedDownloadBytes = result.downloadBytes;
      cachedPackagesAt = now;
      return result;
    })
    .finally(() => {
      if (inflightRead === promise) inflightRead = null;
    });
  inflightRead = promise;
  return promise;
}

/**
 * Sync package database and count upgradable packages.
 * Supports Debian/Ubuntu (apt) and Arch Linux (pacman) via wisp-os-update.
 * Internally runs the same apt invocation as `listUpgradablePackages` and
 * shares an in-flight promise — concurrent check/list calls coalesce.
 * @param {AbortSignal} [signal]
 * @returns { Promise<{ count: number }> }
 * @throws {{ code: 'UPDATE_CHECK_UNAVAILABLE' | 'UPDATE_BUSY', message: string, detail?: string }}
 */
export async function checkForUpdates(signal) {
  const result = await runListShared(signal);
  return { count: result.packages.length };
}

/**
 * Sync package database and perform a full non-interactive upgrade.
 * Refuses if any read or upgrade op is already in flight (apt would block on lock).
 * @param {AbortSignal} [signal]
 * @returns { Promise<{ ok: true }> }
 * @throws {{ code: 'UPDATE_CHECK_UNAVAILABLE' | 'UPDATE_BUSY', message: string, detail?: string }}
 */
export async function performUpgrade(signal, { onLine } = {}) {
  if (inflightUpgrade) {
    throw createAppError(BUSY, 'An OS upgrade is already in progress', 'Wait for the running upgrade to complete');
  }
  if (inflightRead) {
    throw createAppError(BUSY, 'An update check is in progress', 'Try again once the check completes');
  }
  const scriptPath = await getScriptPath();
  const promise = runUpdateScript(scriptPath, 'upgrade', { idleMs: UPGRADE_IDLE_MS, signal, onLine })
    .then(() => {
      const now = new Date().toISOString();
      cachedUpdateCount = 0;
      cachedPackages = [];
      cachedDownloadBytes = 0;
      cachedLastCheckedAt = now;
      cachedPackagesAt = now;
      return { ok: true };
    })
    .finally(() => {
      if (inflightUpgrade === promise) inflightUpgrade = null;
    });
  inflightUpgrade = promise;
  return promise;
}

/**
 * Return the upgradable-package list. By default serves the cached list
 * (populated by the background hourly check or any prior call) so the UI's
 * "View packages" modal opens instantly. Pass `{ useCache: false }` to force
 * a fresh apt invocation; `{ cacheOnly: true }` answers null instead of
 * running one when there is no cache yet.
 * @param {AbortSignal} [signal]
 * @param { { useCache?: boolean, cacheOnly?: boolean } } [opts]
 * @returns { Promise<{ packages: Array<{ name: string, from: string|null, to: string }>, downloadBytes: number, cached: boolean, lastCheckedAt: string|null }> }
 * @throws {{ code: 'UPDATE_CHECK_UNAVAILABLE' | 'UPDATE_BUSY', message: string, detail?: string }}
 */
export async function listUpgradablePackages(signal, { useCache = true, cacheOnly = false } = {}) {
  if (cacheOnly && cachedPackages == null) return null;
  if (useCache && cachedPackages != null) {
    return {
      packages: cachedPackages,
      downloadBytes: cachedDownloadBytes,
      cached: true,
      lastCheckedAt: cachedPackagesAt,
    };
  }
  const result = await runListShared(signal);
  return {
    packages: result.packages,
    downloadBytes: result.downloadBytes,
    cached: false,
    lastCheckedAt: cachedPackagesAt,
  };
}

const INITIAL_DELAY_MS = 30_000;
const INTERVAL_MS = 60 * 60 * 1000; // 1 hour

let intervalId = null;
let initialTimeoutId = null;

/** AbortController for the in-flight background subprocess (must be killed on SIGTERM). */
let activeBackgroundCheckAbort = null;

/**
 * Start background hourly update check. First check after INITIAL_DELAY_MS.
 * Uses the `list` op so the package cache is primed for the UI's
 * "View packages" modal — same apt cost as a count-only check.
 * Safe to call multiple times; only starts once.
 * @param { { warn: (o: object, msg: string) => void } } [log] - Optional logger for warnings
 */
export function startUpdateChecker(log) {
  if (intervalId != null) return;

  function runCheck() {
    /* If a user-triggered op is already running, skip this tick — its result
     * will populate the same caches the background op would have. */
    if (inflightRead || inflightUpgrade) return;

    const ac = new AbortController();
    activeBackgroundCheckAbort = ac;
    runListShared(ac.signal)
      .catch((err) => {
        if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') return;
        if (err?.code === BUSY) {
          if (log) log.warn({ detail: err.detail }, 'Background update check skipped — package manager busy');
          return;
        }
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
 * Clear background timers and abort any running wisp-os-update list so the process can exit on SIGTERM.
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
