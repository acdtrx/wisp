import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createAppError } from '../../appErrors.js';
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
 * Updates): the helper passes apt's output through on stderr, and the
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
    /* stdin is /dev/null: anything in the apt/dpkg chain that reads a
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
        /* EX_TEMPFAIL: another apt/dpkg process holds the package-manager lock. */
        reject(createAppError(BUSY, 'Another package manager operation is running on the host', stderr.trim().split('\n').slice(-5).join('\n') || 'package manager lock held by another process'));
      } else {
        reject(createAppError(UNAVAILABLE, `OS update ${action} failed (privilege or package manager error)`, stderr.trim().split('\n').slice(-20).join('\n') || `exit ${code}`));
      }
    });
  });
}

/**
 * Run the `list` op against wisp-os-update and parse its structured output.
 * Called only through `runListShared` (which adds caching + dedup).
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
  const promise = getScriptPath()
    .then((scriptPath) => runUpdateScript(scriptPath, 'upgrade', { idleMs: UPGRADE_IDLE_MS, signal, onLine }))
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
