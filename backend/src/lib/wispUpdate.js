/**
 * Self-update: poll GitHub Releases hourly, download + verify the latest tarball,
 * stage it under /var/lib/wisp/updates/, and hand off to wisp-updater.service
 * (a Type=oneshot systemd unit) which performs the atomic swap and service
 * restart in its own cgroup, fully detached from this backend process.
 *
 * Which release counts as "latest" depends on the host's `updateChannel`
 * setting: stable takes GitHub's own latest (prereleases excluded server-side),
 * beta takes the highest semver among the recent releases.
 *
 * Repo defaults to acdtrx/wisp; override with WISP_UPDATE_REPO in runtime.env
 * for forks or testing.
 */
import { readFileSync, createWriteStream, createReadStream } from 'node:fs';
import { mkdir, rm, access, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { Agent, fetch as undiciFetch } from 'undici';
import { createAppError } from './routeErrors.js';
import { getSettings } from './settings.js';
import { ssrfSafeFetch } from './downloads/downloadFromUrl.js';

const execFileAsync = promisify(execFileCb);

const __dirname = dirname(fileURLToPath(import.meta.url));
/* backend/src/lib → project root (install dir on the deployed host) */
const INSTALL_DIR = resolve(__dirname, '../../..');

/**
 * Staging directory for downloaded tarballs and extracted release trees. Lives
 * under /var/lib/wisp/ which is created and chowned to the deploy user by
 * scripts/linux/setup/dirs.sh — `/opt` (the typical install dir parent) is
 * root-owned, so we can't stage adjacent to the install dir without sudo.
 */
const STAGING_ROOT = '/var/lib/wisp/updates';

const DEFAULT_REPO = 'acdtrx/wisp';
function getRepo() {
  return (process.env.WISP_UPDATE_REPO || DEFAULT_REPO).trim();
}

const UPDATER_UNIT = 'wisp-updater.service';
const UPDATER_UNIT_FILE = '/etc/systemd/system/wisp-updater.service';
const TARGET_FILE = join(STAGING_ROOT, 'target');

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly
const INITIAL_DELAY_MS = 30_000;
const HTTP_TIMEOUT_MS = 30_000;

/* Releases fetched per beta check. The newest release is always in the first
 * page, so this only has to cover "the highest version isn't the newest by
 * date" — a stable cut published after a later-numbered prerelease. */
const BETA_LIST_SIZE = 15;

/* In-memory cache. Shape exposed via getCachedStatus(). */
const cache = {
  current: getCurrentVersion(),
  latest: null,
  available: false,
  notes: null,
  publishedAt: null,
  asset: null,
  sha256Asset: null,
  lastChecked: null,
  lastError: null,
};

export function getCurrentVersion() {
  try {
    const pkg = JSON.parse(readFileSync(resolve(INSTALL_DIR, 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    /* root package.json missing during dev — fall back to backend's, which always exists */
    try {
      const pkg = JSON.parse(readFileSync(resolve(INSTALL_DIR, 'backend/package.json'), 'utf8'));
      return pkg.version || '0.0.0';
    } catch {
      return '0.0.0';
    }
  }
}

const NUMERIC_IDENTIFIER_RE = /^\d+$/;

/* Leading `v` optional, trailing `+build` metadata (and anything else past the
 * prerelease) ignored — build metadata carries no precedence. */
function parseSemver(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v).trim());
  if (!m) return { major: 0, minor: 0, patch: 0, prerelease: [] };
  return {
    major: parseInt(m[1], 10),
    minor: parseInt(m[2], 10),
    patch: parseInt(m[3], 10),
    prerelease: m[4] ? m[4].split('.') : [],
  };
}

/* Semver identifier precedence: two numeric identifiers compare numerically, a
 * numeric identifier is always lower than an alphanumeric one, and two
 * alphanumerics compare in ASCII order. */
function comparePrereleaseIdentifier(a, b) {
  const aNumeric = NUMERIC_IDENTIFIER_RE.test(a);
  const bNumeric = NUMERIC_IDENTIFIER_RE.test(b);
  if (aNumeric && bNumeric) return parseInt(a, 10) - parseInt(b, 10);
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function comparePrerelease(a, b) {
  /* A version with a prerelease list is lower than the same version without. */
  if (a.length === 0) return b.length === 0 ? 0 : 1;
  if (b.length === 0) return -1;
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const cmp = comparePrereleaseIdentifier(a[i], b[i]);
    if (cmp !== 0) return cmp;
  }
  /* Prefix-equal: the shorter list is lower (2.2.0-beta < 2.2.0-beta.1). */
  return a.length - b.length;
}

/**
 * Compare two semver strings by spec precedence. Returns >0 if a>b, 0 if eq,
 * <0 if a<b. Exported for verification.
 */
export function compareSemver(a, b) {
  const va = parseSemver(a);
  const vb = parseSemver(b);
  if (va.major !== vb.major) return va.major - vb.major;
  if (va.minor !== vb.minor) return va.minor - vb.minor;
  if (va.patch !== vb.patch) return va.patch - vb.patch;
  return comparePrerelease(va.prerelease, vb.prerelease);
}

export function getCachedStatus() {
  return {
    current: cache.current,
    latest: cache.latest,
    available: cache.available,
    notes: cache.notes,
    publishedAt: cache.publishedAt,
    lastChecked: cache.lastChecked,
    lastError: cache.lastError,
    repo: getRepo(),
  };
}

/* Records the failure on the cache and returns the error to throw, so every
 * check failure timestamps itself the same way. */
function checkFailure(lastError, message, detail) {
  cache.lastError = lastError;
  cache.lastChecked = new Date().toISOString();
  return createAppError('UPDATE_CHECK_UNAVAILABLE', message, detail);
}

function malformedResponse() {
  return checkFailure('Malformed GitHub API response', 'Malformed GitHub API response');
}

/** GET a GitHub API endpoint. Returns null on 404 — the repo has no releases. */
async function fetchGithubJson(url, signal) {
  const dispatcher = new Agent({ headersTimeout: HTTP_TIMEOUT_MS, bodyTimeout: HTTP_TIMEOUT_MS });
  let res;
  try {
    res = await undiciFetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': `wisp-updater/${cache.current}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      dispatcher,
      signal,
    });
  } catch (err) {
    throw checkFailure(`Network error: ${err.message}`, 'Failed to reach GitHub Releases', err.message);
  }
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw checkFailure(`GitHub API ${res.status}`, `GitHub API returned ${res.status}`, body.slice(0, 200));
  }
  const data = await res.json().catch(() => null);
  if (!data || typeof data !== 'object') throw malformedResponse();
  return data;
}

/**
 * Stable channel. GitHub's `releases/latest` excludes prereleases server-side,
 * so the release it names is always the newest stable one.
 */
async function fetchStableRelease(repo, signal) {
  const data = await fetchGithubJson(`https://api.github.com/repos/${repo}/releases/latest`, signal);
  if (data === null) return null;
  if (Array.isArray(data)) throw malformedResponse();
  return data;
}

/**
 * Beta channel. Lists recent releases (prereleases included) and picks the
 * highest semver tag among the published ones. No release in the window —
 * empty repo, or drafts only — reads as "nothing to update to".
 */
async function fetchBetaRelease(repo, signal) {
  const data = await fetchGithubJson(
    `https://api.github.com/repos/${repo}/releases?per_page=${BETA_LIST_SIZE}`,
    signal,
  );
  if (data === null) return null;
  if (!Array.isArray(data)) throw malformedResponse();
  let best = null;
  for (const release of data) {
    if (!release || typeof release !== 'object' || release.draft === true) continue;
    if (best === null || compareSemver(release.tag_name || '', best.tag_name || '') > 0) {
      best = release;
    }
  }
  return best;
}

/** Fill the cache from a GitHub release object (or clear it when given null). */
function cacheRelease(release) {
  cache.lastError = null;
  cache.lastChecked = new Date().toISOString();
  if (!release) {
    /* Nothing published on this channel — not an error, just nothing to update to. */
    cache.latest = null;
    cache.available = false;
    cache.notes = null;
    cache.publishedAt = null;
    cache.asset = null;
    cache.sha256Asset = null;
    return getCachedStatus();
  }

  const tag = String(release.tag_name || '');
  const latest = tag.replace(/^v/, '');
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const tarballAsset = assets.find((a) => /^wisp-[\d].*\.tar\.gz$/.test(a.name || ''));
  const sha256Asset = assets.find((a) => /^wisp-[\d].*\.tar\.gz\.sha256$/.test(a.name || ''));

  cache.latest = latest || null;
  cache.publishedAt = release.published_at || null;
  cache.notes = release.body || null;
  cache.asset = tarballAsset
    ? { name: tarballAsset.name, url: tarballAsset.browser_download_url, size: tarballAsset.size }
    : null;
  cache.sha256Asset = sha256Asset
    ? { name: sha256Asset.name, url: sha256Asset.browser_download_url }
    : null;
  /* Strictly newer only — a beta host that flips back to stable is never
   * offered a downgrade, it just waits for stable to catch up. */
  cache.available = !!latest && compareSemver(latest, cache.current) > 0 && !!cache.asset && !!cache.sha256Asset;
  return getCachedStatus();
}

/**
 * Find the release this host's channel should be on, parse it, and update the
 * cache. Returns the new cached status. Throws
 * { code: 'UPDATE_CHECK_UNAVAILABLE', ... } on network/parse errors so route
 * handlers can map to a 503.
 *
 * The channel is read from settings at check time — flipping it in the UI takes
 * effect on the next check, with no wiring from settings back into the checker.
 */
export async function checkForUpdate(signal) {
  const repo = getRepo();
  const { updateChannel } = await getSettings();
  const release = updateChannel === 'beta'
    ? await fetchBetaRelease(repo, signal)
    : await fetchStableRelease(repo, signal);
  return cacheRelease(release);
}

async function downloadToFile(url, destPath, onProgress, signal) {
  // Route through the same SSRF-safe fetch used for library downloads: DNS-pinned,
  // private/loopback IPs blocked, and every redirect Location re-validated. The
  // asset URL comes from the GitHub API (not user input at the API layer), so this
  // is defense-in-depth against a hostile WISP_UPDATE_REPO or a redirect to an
  // internal endpoint.
  const res = await ssrfSafeFetch(url, {
    method: 'GET',
    headers: { 'User-Agent': `wisp-updater/${cache.current}`, 'Accept': 'application/octet-stream' },
    signal,
  });
  if (!res.ok) {
    throw createAppError('DOWNLOAD_FAILED', `Download failed (HTTP ${res.status})`, url);
  }
  const totalHeader = res.headers.get('content-length');
  const total = totalHeader ? parseInt(totalHeader, 10) : null;
  let received = 0;
  const out = createWriteStream(destPath);
  const reader = res.body.getReader();
  let lastReport = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      out.write(value);
      const now = Date.now();
      if (onProgress && now - lastReport > 250) {
        lastReport = now;
        onProgress({ received, total });
      }
    }
  } finally {
    out.end();
    await new Promise((r, j) => {
      out.on('finish', r);
      out.on('error', j);
    });
  }
  if (onProgress) onProgress({ received, total: total || received });
  return { received, total };
}

async function fileSha256(path) {
  return await new Promise((resolveHash, reject) => {
    const h = createHash('sha256');
    const s = createReadStream(path);
    s.on('data', (chunk) => h.update(chunk));
    s.on('end', () => resolveHash(h.digest('hex')));
    s.on('error', reject);
  });
}

/**
 * Download the latest release tarball + sha256, verify, extract to a staging
 * dir adjacent to the install dir. Returns the staging dir absolute path.
 *
 * Progress callback receives one of:
 *   { step: 'download', received, total }
 *   { step: 'verify' }
 *   { step: 'extract' }
 */
export async function downloadAndStage(onProgress, signal) {
  if (!cache.asset || !cache.sha256Asset) {
    throw createAppError('UPDATE_CHECK_UNAVAILABLE', 'No update available — run check first');
  }
  const version = cache.latest;
  await mkdir(STAGING_ROOT, { recursive: true });
  const stagingDir = join(STAGING_ROOT, `staging-${version}`);
  const tarballPath = join(STAGING_ROOT, `wisp-${version}.tar.gz`);
  const shaPath = join(STAGING_ROOT, `wisp-${version}.tar.gz.sha256`);

  /* Wipe any previous attempt for this version */
  await rm(stagingDir, { recursive: true, force: true });
  await rm(tarballPath, { force: true });
  await rm(shaPath, { force: true });

  if (onProgress) onProgress({ step: 'download', received: 0, total: cache.asset.size || null });
  await downloadToFile(cache.asset.url, tarballPath, (p) => {
    if (onProgress) onProgress({ step: 'download', received: p.received, total: p.total });
  }, signal);

  /* Tiny file — fetch via fetch, parse "<hash>  filename" format from sha256sum. */
  await downloadToFile(cache.sha256Asset.url, shaPath, null, signal);

  if (onProgress) onProgress({ step: 'verify' });
  const expected = readFileSync(shaPath, 'utf8').trim().split(/\s+/)[0];
  const actual = await fileSha256(tarballPath);
  if (!/^[0-9a-f]{64}$/i.test(expected) || actual.toLowerCase() !== expected.toLowerCase()) {
    await rm(tarballPath, { force: true });
    await rm(shaPath, { force: true });
    throw createAppError('HASH_FAILED', 'Tarball checksum mismatch', `expected ${expected}, got ${actual}`);
  }

  if (onProgress) onProgress({ step: 'extract' });
  await mkdir(stagingDir, { recursive: true });
  /* Tarball top-level dir is `wisp/`; --strip-components=1 puts contents at stagingDir root. */
  await execFileAsync('tar', ['-xzf', tarballPath, '-C', stagingDir, '--strip-components=1']);

  /* Sanity-check: backend/package.json must exist with the expected version. */
  let stagingVersion = null;
  try {
    const stagingPkg = JSON.parse(readFileSync(join(stagingDir, 'backend/package.json'), 'utf8'));
    stagingVersion = stagingPkg.version;
  } catch (err) {
    throw createAppError('UPDATE_CHECK_UNAVAILABLE', 'Staged tree is missing backend/package.json', err.message);
  }
  if (stagingVersion !== version) {
    throw createAppError('UPDATE_CHECK_UNAVAILABLE', 'Staged tree version mismatch', `expected ${version}, got ${stagingVersion}`);
  }

  /* Tarball + sha file aren't needed past verification. Helper consumes the dir. */
  await rm(tarballPath, { force: true });
  await rm(shaPath, { force: true });

  return stagingDir;
}

/**
 * Trigger wisp-updater.service. Because that's a separate systemd unit running
 * in its own cgroup with its own stdio, the updater is fully decoupled from
 * this backend process — when the updater stops wisp.service as its
 * first real step, nothing connecting the two breaks.
 *
 * Hand-off contract:
 *   - Backend writes the staging path to /var/lib/wisp/updates/target.
 *   - Backend invokes `sudo -n /usr/bin/systemctl start --no-block wisp-updater.service`.
 *   - Updater reads the target file and the install dir (from the unit's
 *     WISP_INSTALL_DIR env), does its job, deletes the target file on success.
 *
 * UI detects completion by polling GET /api/host for wispVersion === target.
 * Updater progress is in journald: `journalctl -u wisp-updater.service`.
 */
export async function applyUpdate(stagingPath) {
  if (typeof stagingPath !== 'string' || !stagingPath.startsWith(`${STAGING_ROOT}/staging-`)) {
    throw createAppError('INVALID_REQUEST', 'staging path must be inside /var/lib/wisp/updates/');
  }
  try {
    await access(UPDATER_UNIT_FILE);
  } catch {
    throw createAppError(
      'UPDATE_CHECK_UNAVAILABLE',
      `${UPDATER_UNIT_FILE} missing — run scripts/linux/setup/install-helpers.sh`
    );
  }

  /* Atomic write: stage to .tmp, rename into place. The updater reads this
   * file on start, so a partial write would be a real bug. */
  const tmp = `${TARGET_FILE}.tmp`;
  await writeFile(tmp, `${stagingPath}\n`, { mode: 0o644 });
  await rename(tmp, TARGET_FILE);

  const isRoot = process.getuid && process.getuid() === 0;
  const argv = isRoot
    ? ['/usr/bin/systemctl', 'start', '--no-block', UPDATER_UNIT]
    : ['sudo', '-n', '/usr/bin/systemctl', 'start', '--no-block', UPDATER_UNIT];

  await execFileAsync(argv[0], argv.slice(1));
  return { started: true };
}

let intervalId = null;
let initialTimeoutId = null;
let activeAbort = null;

/** Start the hourly auto-check. First check after INITIAL_DELAY_MS. */
export function startUpdateChecker(log) {
  if (intervalId != null) return;
  function run() {
    const ac = new AbortController();
    activeAbort = ac;
    checkForUpdate(ac.signal)
      .catch((err) => {
        if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') return;
        if (log) log.warn({ err: err.message }, 'Wisp update check failed');
      })
      .finally(() => {
        if (activeAbort === ac) activeAbort = null;
      });
  }
  initialTimeoutId = setTimeout(() => {
    initialTimeoutId = null;
    run();
  }, INITIAL_DELAY_MS);
  intervalId = setInterval(run, CHECK_INTERVAL_MS);
}

export function stopUpdateChecker() {
  if (initialTimeoutId != null) {
    clearTimeout(initialTimeoutId);
    initialTimeoutId = null;
  }
  if (intervalId != null) {
    clearInterval(intervalId);
    intervalId = null;
  }
  if (activeAbort != null) {
    try { activeAbort.abort(); } catch { /* abort is sync — ignore odd platforms */ }
    activeAbort = null;
  }
}
