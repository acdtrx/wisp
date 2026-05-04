/**
 * Sum compressed content-store sizes (config + layer blobs) for an image, matching the host
 * platform manifest. The Images API `target.size` is only the top-level manifest/index blob
 * size — not useful for display.
 */
import { getClient, callUnary, callStream, collectStream } from './containerManagerConnection.js';

const OCI_ARCH = ({ x64: 'amd64', arm64: 'arm64', arm: 'arm' })[process.arch] || process.arch;

function normalizeOCIArchitecture(arch) {
  if (!arch || typeof arch !== 'string') return '';
  const a = arch.toLowerCase();
  if (a === 'x86_64' || a === 'x86-64') return 'amd64';
  if (a === 'aarch64') return 'arm64';
  return a;
}

function variantPreference(platform) {
  if (!platform) return 0;
  const arch = normalizeOCIArchitecture(platform.architecture);
  const v = (platform.variant || '').toLowerCase();
  if (arch === 'arm64') {
    if (v === 'v8' || v === '') return 3;
    return 1;
  }
  if (arch === 'arm') {
    if (v === 'v7') return 3;
    if (v === 'v6') return 2;
    if (v === '') return 1;
    return 0;
  }
  return 1;
}

/**
 * Pick the child descriptor for this host from an OCI index / Docker manifest list.
 * Returns null if no Linux manifest matches the host arch (caller treats as unknown size).
 */
function pickLinuxManifestDescriptor(manifests) {
  if (!Array.isArray(manifests)) return null;
  const linux = manifests.filter((m) => {
    const p = m.platform;
    if (!p) return false;
    if ((p.os || '').toLowerCase() !== 'linux') return false;
    return normalizeOCIArchitecture(p.architecture) === OCI_ARCH;
  });
  if (linux.length === 0) return null;
  linux.sort((a, b) => {
    const d = variantPreference(b.platform) - variantPreference(a.platform);
    if (d !== 0) return d;
    return String(a.digest || '').localeCompare(String(b.digest || ''));
  });
  return linux[0] ?? null;
}

async function readContent(digest) {
  const chunks = await collectStream(
    callStream(getClient('content'), 'read', { digest }),
  );
  return Buffer.concat(chunks.map((c) => c.data));
}

/**
 * Walk index/manifest list to the leaf image manifest for this host (same strategy as create).
 * @returns {object|null} Parsed JSON manifest with `layers` and optional `config`, or null.
 */
async function resolveLeafImageManifest(imageName) {
  const imgRes = await callUnary(getClient('images'), 'get', { name: imageName });
  const digest = imgRes.image?.target?.digest;
  if (!digest) return null;

  let parsed = JSON.parse((await readContent(digest)).toString('utf8'));
  const maxDepth = 8;
  let depth = 0;

  while (parsed.manifests && depth < maxDepth) {
    const entry = pickLinuxManifestDescriptor(parsed.manifests);
    if (!entry?.digest) return null;
    parsed = JSON.parse((await readContent(entry.digest)).toString('utf8'));
    depth += 1;
  }

  if (parsed.manifests) return null;
  return parsed;
}

/**
 * Total compressed bytes in the content store for this image (config + layer descriptors),
 * for the resolved Linux manifest. Returns null if the manifest cannot be resolved or has no sizes.
 */
export async function compressedBlobSizeForImageName(imageName) {
  if (!imageName) return null;
  try {
    const parsed = await resolveLeafImageManifest(imageName);
    if (!parsed) return null;

    let total = 0;
    if (parsed.config?.size != null) {
      total += Number(parsed.config.size);
    }
    if (Array.isArray(parsed.layers)) {
      for (const layer of parsed.layers) {
        if (layer?.size != null) {
          total += Number(layer.size);
        }
      }
    }

    if (!Number.isFinite(total) || total <= 0) return null;
    return total;
  } catch {
    return null;
  }
}
