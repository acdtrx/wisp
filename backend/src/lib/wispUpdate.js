/**
 * Self-update: poll GitHub Releases hourly, download + verify the latest tarball,
 * stage it next to the install dir, and hand off to the privileged `wisp-update`
 * helper which performs the atomic swap and service restart.
 *
 * Repo defaults to acdtrx/wisp; override with WISP_UPDATE_REPO in runtime.env
 * for forks or testing.
 */
import { readFileSync, createWriteStream, createReadStream } from 'node:fs';
import { mkdir, rm, stat, access } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { Agent, fetch as undiciFetch } from 'undici';
import { createAppError } from './routeErrors.js';

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

const HELPER_PATH = '/usr/local/bin/wisp-update';

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly
const INITIAL_DELAY_MS = 30_000;
const HTTP_TIMEOUT_MS = 30_000;

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

function getCurrentVersion() {
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

/** Compare two semver-shaped strings. Returns >0 if a>b, 0 if eq, <0 if a<b. */
function compareSemver(a, b) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v));
    if (!m) return [0, 0, 0];
    return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
  };
  const [ax, ay, az] = parse(a);
  const [bx, by, bz] = parse(b);
  if (ax !== bx) return ax - bx;
  if (ay !== by) return ay - by;
  return az - bz;
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

/**
 * Hit GitHub's releases/latest endpoint, parse, and update the cache. Returns
 * the new cached status. Throws { code: 'UPDATE_CHECK_UNAVAILABLE', ... } on
 * network/parse errors so route handlers can map to a 503.
 *
 * GitHub's `releases/latest` excludes prereleases server-side, which is exactly
 * what we want for the auto-check path.
 */
export async function checkForUpdate(signal) {
  const repo = getRepo();
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const dispatcher = new Agent({ headersTimeout: HTTP_TIMEOUT_MS, bodyTimeout: HTTP_TIMEOUT_MS });
  let res;
  try {
    res = await undiciFetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': `wisp-update/${cache.current}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      dispatcher,
      signal,
    });
  } catch (err) {
    cache.lastError = `Network error: ${err.message}`;
    cache.lastChecked = new Date().toISOString();
    throw createAppError('UPDATE_CHECK_UNAVAILABLE', 'Failed to reach GitHub Releases', err.message);
  }

  if (res.status === 404) {
    /* Repo has no releases yet — not an error, just nothing to update to. */
    cache.latest = null;
    cache.available = false;
    cache.notes = null;
    cache.publishedAt = null;
    cache.asset = null;
    cache.sha256Asset = null;
    cache.lastError = null;
    cache.lastChecked = new Date().toISOString();
    return getCachedStatus();
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    cache.lastError = `GitHub API ${res.status}`;
    cache.lastChecked = new Date().toISOString();
    throw createAppError('UPDATE_CHECK_UNAVAILABLE', `GitHub API returned ${res.status}`, body.slice(0, 200));
  }
  const data = await res.json().catch(() => null);
  if (!data || typeof data !== 'object') {
    cache.lastError = 'Malformed GitHub API response';
    cache.lastChecked = new Date().toISOString();
    throw createAppError('UPDATE_CHECK_UNAVAILABLE', 'Malformed GitHub API response');
  }

  const tag = String(data.tag_name || '');
  const latest = tag.replace(/^v/, '');
  const assets = Array.isArray(data.assets) ? data.assets : [];
  const tarballAsset = assets.find((a) => /^wisp-[\d].*\.tar\.gz$/.test(a.name || ''));
  const sha256Asset = assets.find((a) => /^wisp-[\d].*\.tar\.gz\.sha256$/.test(a.name || ''));

  cache.latest = latest || null;
  cache.publishedAt = data.published_at || null;
  cache.notes = data.body || null;
  cache.asset = tarballAsset
    ? { name: tarballAsset.name, url: tarballAsset.browser_download_url, size: tarballAsset.size }
    : null;
  cache.sha256Asset = sha256Asset
    ? { name: sha256Asset.name, url: sha256Asset.browser_download_url }
    : null;
  cache.available = !!latest && compareSemver(latest, cache.current) > 0 && !!cache.asset && !!cache.sha256Asset;
  cache.lastError = null;
  cache.lastChecked = new Date().toISOString();
  return getCachedStatus();
}

async function downloadToFile(url, destPath, onProgress, signal) {
  const dispatcher = new Agent({ headersTimeout: HTTP_TIMEOUT_MS, bodyTimeout: 5 * 60_000 });
  const res = await undiciFetch(url, {
    method: 'GET',
    headers: { 'User-Agent': `wisp-update/${cache.current}`, 'Accept': 'application/octet-stream' },
    redirect: 'follow',
    dispatcher,
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
 * Hand off to the privileged helper. Streams its stdout (lines of `step:<name>`)
 * to onProgress so the SSE picks up "stop-services", "snapshot", "swap", etc.
 *
 * NOTE: the helper restarts wisp-backend at the end. The helper's own exit
 * happens BEFORE that restart blocks our process. The new backend boots, this
 * old one is killed by systemd; the SSE client will see the stream close and
 * reconnect to the new backend (which has a different jobId map but the
 * pre-restart "step:done" was already pushed).
 */
export async function applyUpdate(stagingPath, onProgress) {
  if (typeof stagingPath !== 'string' || !stagingPath.startsWith('/')) {
    throw createAppError('INVALID_REQUEST', 'staging path must be absolute');
  }
  try {
    await access(HELPER_PATH);
  } catch {
    throw createAppError('UPDATE_CHECK_UNAVAILABLE', 'wisp-update helper missing on /usr/local/bin');
  }
  const isRoot = process.getuid && process.getuid() === 0;
  const argv = isRoot
    ? [HELPER_PATH, stagingPath, INSTALL_DIR]
    : ['sudo', '-n', HELPER_PATH, stagingPath, INSTALL_DIR];
  const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderrBuf = '';
  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString('utf8');
  });
  let stdoutBuf = '';
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf8');
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line) continue;
      const m = /^step:(.+)$/.exec(line);
      if (m && onProgress) onProgress({ step: m[1] });
    }
  });

  return new Promise((resolveExit, rejectExit) => {
    child.on('error', rejectExit);
    child.on('close', (code) => {
      if (code === 0) {
        resolveExit({ ok: true });
      } else {
        rejectExit(createAppError('UPDATE_CHECK_UNAVAILABLE', `wisp-update helper exited ${code}`, stderrBuf.trim().slice(-400) || undefined));
      }
    });
  });
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
