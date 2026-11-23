/**
 * Sum compressed content-store sizes (config + layer blobs) for an image, matching the host
 * platform manifest. The Images API `target.size` is only the top-level manifest/index blob
 * size — not useful for display.
 */
import { getClient, callUnary, callStream, collectStream, STREAM_DEADLINE_MS } from './containerManagerConnection.js';
import { hostLinuxManifests } from './containerManagerPlatform.js';

/**
 * Pick the child descriptor for this host from an OCI index / Docker manifest list.
 * Returns null if no Linux manifest matches the host arch (caller treats as unknown size).
 */
function pickLinuxManifestDescriptor(manifests) {
  return hostLinuxManifests(manifests)[0] ?? null;
}

async function readContent(digest) {
  const chunks = await collectStream(
    callStream(getClient('content'), 'read', { digest }, { deadlineMs: STREAM_DEADLINE_MS }),
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
    return null; // the size is shown only: unknown (null) when the content store cannot tell it
  }
}
