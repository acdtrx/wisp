import { createAppError } from '../../appErrors.js';
import { stallMinutes } from '../../storage/index.js';
import { runPrivileged, helperPath } from '../../base/index.js';

const SCRIPT_PATH = helperPath('wisp-os-update');

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

/** The OS update check runs on this platform (the hourly trigger arms only where it does). */
export const supportsOsUpdateChecks = true;

export function getPendingUpdatesCount() {
  return cachedUpdateCount;
}

export function getLastCheckedAt() {
  return cachedLastCheckedAt;
}

/**
 * The package list the last check (or upgrade) left, with when it ran; null
 * before any.
 * @returns {{ packages: Array<{ name: string, from: string|null, to: string }>, downloadBytes: number, checkedAt: string } | null}
 */
export function getCachedPackages() {
  if (cachedPackages == null) return null;
  return {
    packages: cachedPackages,
    downloadBytes: cachedDownloadBytes,
    checkedAt: cachedPackagesAt,
  };
}

/** True when an apt subprocess is in flight (either kind). */
export function isOperationInProgress() {
  return inflightRead != null || inflightUpgrade != null;
}

/** True while an upgrade runs (a check then answers UPDATE_BUSY). */
export function isUpgradeInProgress() {
  return inflightUpgrade != null;
}

/*
 * Bounds (CODING-RULES §6; contracts in docs/specs/HOST-MONITORING.md § OS
 * Updates): the helper passes apt's output through on stderr, and the
 * run is stopped after this long without any of it. Each is above the
 * helper's own bound for its steps, which stops a hung step first: `list` 90 s
 * over 60 s each, `upgrade` 15.5 min over the 15 min a dkms or initramfs build
 * can be silent for.
 */
const LIST_IDLE_MS = 90_000;
const UPGRADE_IDLE_MS = 15.5 * 60_000;

/**
 * Run wisp-os-update `action` through the privileged runner, stopped after
 * `idleMs` without output. `onLine(text)` gets each non-empty stderr line
 * (progress). Resolves `{ stdout, stderr }`.
 * @param {AbortSignal} [signal] - When aborted (e.g. process shutdown), the helper is stopped.
 */
async function runUpdateScript(scriptPath, action, { idleMs, signal, onLine } = {}) {
  try {
    /* The helper relays SIGTERM to its step's child; 15 s later it is killed. */
    return await runPrivileged(scriptPath, [action], { stallMs: idleMs, graceMs: 15_000, signal, onStderrLine: onLine });
  } catch (err) {
    const tail = (lines) => String(err.stderr || '').trim().split('\n').slice(-lines).join('\n');
    if (err.reason === 'missing') throw createAppError(UNAVAILABLE, 'wisp-os-update script not found or not readable', err.message);
    if (err.reason === 'aborted') {
      const aborted = createAppError('ABORT_ERR', `OS update ${action} was stopped`);
      aborted.name = 'AbortError';
      throw aborted;
    }
    if (err.reason === 'timed-out') {
      throw createAppError(UNAVAILABLE, `OS update ${action} printed nothing for ${stallMinutes(idleMs)} and was stopped`, tail(5));
    }
    if (err.reason === 'busy') {
      /* EX_TEMPFAIL: another apt/dpkg process holds the package-manager lock. */
      throw createAppError(BUSY, 'Another package manager operation is running on the host', tail(5) || 'package manager lock held by another process');
    }
    throw createAppError(UNAVAILABLE, `OS update ${action} failed (${err.reason ?? 'error'})`, tail(20) || err.message);
  }
}

/**
 * Run the `list` op against wisp-os-update and parse its structured output.
 * Called only through `runListShared` (which adds caching + dedup).
 */
async function runListOp(signal) {
  const { stdout } = await runUpdateScript(SCRIPT_PATH, 'list', { idleMs: LIST_IDLE_MS, signal });
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
 * The driver of `checkForUpdates`.
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
 * Sync package database, list the upgradable packages into the cache
 * (`getCachedPackages`) and count them. Debian/Ubuntu (apt), through
 * wisp-os-update. Concurrent calls share one in-flight run.
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
export function performUpgrade(signal, { onLine } = {}) {
  if (inflightUpgrade) {
    return Promise.reject(createAppError(BUSY, 'An OS upgrade is already in progress', 'Wait for the running upgrade to complete'));
  }
  if (inflightRead) {
    return Promise.reject(createAppError(BUSY, 'An update check is in progress', 'Try again once the check completes'));
  }
  // inflightUpgrade is set before anything awaits, so a second upgrade or a
  // check started meanwhile sees it.
  const promise = runUpdateScript(SCRIPT_PATH, 'upgrade', { idleMs: UPGRADE_IDLE_MS, signal, onLine })
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
