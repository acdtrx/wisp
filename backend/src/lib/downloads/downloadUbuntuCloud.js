/**
 * Download latest Ubuntu Server LTS cloud image (QCOW2/IMG) from cloud-images.ubuntu.com.
 * Resolves "latest LTS" at runtime from Canonical's simplestreams catalog, falling back
 * to a small hardcoded list if the endpoint is unreachable or unparseable.
 */

import { ensureImageDir } from '../paths.js';
import { findUniqueFilename, downloadWithProgress } from './downloadUtils.js';

const SIMPLESTREAMS_URL =
  'https://cloud-images.ubuntu.com/releases/streams/v1/com.ubuntu.cloud:released:download.json';
const SIMPLESTREAMS_TIMEOUT_MS = 8000;
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

async function fetchLatestLtsFromSimplestreams() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SIMPLESTREAMS_TIMEOUT_MS);
  try {
    const res = await fetch(SIMPLESTREAMS_URL, { redirect: 'follow', signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    return extractLtsProducts(data.products)[0] ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveLatestLts() {
  const latest = await fetchLatestLtsFromSimplestreams();
  if (latest) return buildImageUrl(latest.codename, latest.version);
  const fb = FALLBACK_LTS[0];
  return buildImageUrl(fb.codename, fb.version);
}

/**
 * Download the image to the library. onProgress(percent, loaded, total).
 * Returns { name, type, size, modified }.
 */
export async function downloadUbuntuCloudImage(onProgress) {
  const { url, filename } = await resolveLatestLts();
  const dir = await ensureImageDir();
  const { destPath, filename: finalName } = await findUniqueFilename(dir, filename);
  const result = await downloadWithProgress(url, destPath, onProgress);
  return {
    name: finalName,
    type: result.type,
    size: result.size,
    modified: result.modified,
  };
}
