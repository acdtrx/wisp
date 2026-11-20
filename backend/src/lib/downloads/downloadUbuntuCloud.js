/**
 * Download latest Ubuntu Server LTS cloud image (QCOW2/IMG) from cloud-images.ubuntu.com.
 * Resolves "latest LTS" at runtime from Canonical's simplestreams catalog, falling back
 * to a small hardcoded list if the endpoint is unreachable or unparseable.
 */

import { ensureImageDir } from '../paths.js';
import { downloadToUniqueFile, ssrfSafeFetch } from './downloadFromUrl.js';

const SIMPLESTREAMS_URL =
  'https://cloud-images.ubuntu.com/releases/streams/v1/com.ubuntu.cloud:released:download.json';
const SIMPLESTREAMS_TIMEOUT_MS = 8000;
/** The released-images stream lists every release and architecture: a few tens of MB. */
const SIMPLESTREAMS_MAX_BYTES = 64 * 1024 * 1024;
const BASE = 'https://cloud-images.ubuntu.com/releases';
const FALLBACK_LTS = [
  { codename: 'noble', version: '24.04' },
  { codename: 'jammy', version: '22.04' },
  { codename: 'focal', version: '20.04' },
];

function buildImageUrl(codename, version) {
  const filename = `ubuntu-${version}-server-cloudimg-amd64.img`;
  return { url: `${BASE}/${codename}/release/${filename}`, filename };
}

/**
 * Pull all LTS amd64 server entries out of the simplestreams products map, sorted newest first.
 * Product keys look like "com.ubuntu.cloud:server:26.04:amd64"; LTS entries have
 * release_title ending in "LTS" (e.g. "24.04 LTS"), interim releases don't.
 */
function extractLtsProducts(products) {
  const entries = [];
  for (const [key, p] of Object.entries(products ?? {})) {
    if (!key.startsWith('com.ubuntu.cloud:server:')) continue;
    if (p?.arch !== 'amd64') continue;
    if (typeof p.release_title !== 'string' || !p.release_title.includes('LTS')) continue;
    const m = /^(\d+)\.(\d+)/.exec(p.version ?? '');
    if (!m || typeof p.release !== 'string') continue;
    const major = parseInt(m[1], 10);
    const minor = parseInt(m[2], 10);
    entries.push({
      codename: p.release,
      version: `${m[1]}.${m[2]}`,
      sortKey: major * 100 + minor,
    });
  }
  entries.sort((a, b) => b.sortKey - a.sortKey);
  return entries;
}

/** The newest LTS the release stream lists, or null when it lists none; throws when the lookup fails. */
async function fetchLatestLtsFromSimplestreams() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SIMPLESTREAMS_TIMEOUT_MS);
  try {
    const res = await ssrfSafeFetch(SIMPLESTREAMS_URL, { signal: controller.signal, maxBodyBytes: SIMPLESTREAMS_MAX_BYTES });
    if (!res.ok) throw new Error(`the release stream answered HTTP ${res.status}`);
    const data = await res.json();
    return extractLtsProducts(data.products)[0] ?? null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The newest LTS's image, or the known fallback when the stream cannot say:
 * the download still works, and the warn line says why it is the fallback.
 */
async function resolveLatestLts(log) {
  const fb = FALLBACK_LTS[0];
  try {
    const latest = await fetchLatestLtsFromSimplestreams();
    if (latest) return buildImageUrl(latest.codename, latest.version);
    log.warn({ url: SIMPLESTREAMS_URL, fallback: fb.version }, 'Ubuntu release stream lists no LTS: downloading the fallback release');
  } catch (err) {
    log.warn(
      { url: SIMPLESTREAMS_URL, fallback: fb.version, err: err?.message, code: err?.code, raw: err?.raw },
      'Ubuntu release stream lookup failed: downloading the fallback release',
    );
  }
  return buildImageUrl(fb.codename, fb.version);
}

/**
 * Download the image to the library. onProgress(percent, loaded, total);
 * `log` records a fallback to the known release.
 * Returns { name, type, size, modified }.
 */
export async function downloadUbuntuCloudImage(onProgress, { log }) {
  const { url, filename } = await resolveLatestLts(log);
  const dir = await ensureImageDir();
  return downloadToUniqueFile(url, dir, filename, onProgress);
}
