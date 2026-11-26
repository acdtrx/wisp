/**
 * List and delete OCI images in containerd (wisp namespace).
 */
import { getClient, callUnary } from './containerManagerConnection.js';
import { normalizeImageRef, isImageImportWorkName } from './containerImageRef.js';
import { compressedBlobSizeForImageName } from './containerManagerOciSize.js';
import { readImageMeta, writeImageMeta, withImageMetaWriteLock } from './containerManagerImageMeta.js';

/** @param {unknown} v */
function intFromProtoLong(v) {
  if (v == null) return NaN;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') return Number(v);
  if (typeof v === 'object' && typeof v.toNumber === 'function') return v.toNumber();
  return Number(v);
}

/** google.protobuf.Timestamp from gRPC (field names camelCase when keepCase: false). */
function protoTimestampToIso(ts) {
  if (!ts || typeof ts !== 'object') return null;
  const sec = intFromProtoLong(ts.seconds);
  const nanos = intFromProtoLong(ts.nanos) || 0;
  if (!Number.isFinite(sec)) return null;
  return new Date(sec * 1000 + nanos / 1e6).toISOString();
}

/**
 * The image ref a container stores for a user-given image: the literal name
 * when containerd holds an image by exactly that name (a `ctr image import`
 * like `myapp:v1`, or a name picked from the image library), else the
 * Docker-normalized ref (`nginx:1.27` → `docker.io/library/nginx:1.27`) —
 * the name a pull stores the image under. Create, PATCH and the MCP image
 * update all store refs through this, so a start always finds the image by
 * the stored name.
 * @param {string} imageRef - trimmed, non-empty
 * @returns {Promise<{ ref: string, local: boolean }>} `local` when the literal name is present
 */
export async function resolveContainerImageRef(imageRef) {
  if (await getImageDigest(imageRef)) return { ref: imageRef, local: true };
  return { ref: normalizeImageRef(imageRef), local: false };
}

/**
 * Top-level manifest/index digest containerd currently holds for this reference.
 * @returns {Promise<string | null>} null when the image is not locally present;
 *   any other failure (containerd unreachable) throws.
 */
export async function getImageDigest(imageRef) {
  // An import's own names are no image of the library's.
  if (isImageImportWorkName(imageRef)) return null;
  try {
    const res = await callUnary(getClient('images'), 'get', { name: imageRef });
    return res.image?.target?.digest || null;
  } catch (err) {
    if (err.code === 'CONTAINER_NOT_FOUND') return null;
    throw err;
  }
}

/**
 * @returns {Promise<Array<{ name: string, digest: string, size: number, updated: string }>>}
 */
export async function listContainerImages() {
  const res = await callUnary(getClient('images'), 'list', { filters: [] });
  // An import's own names, while it runs, are no image of the library's.
  const images = (res.images || []).filter((img) => !isImageImportWorkName(img.name));

  return withImageMetaWriteLock(async () => {
    const meta = await readImageMeta();
    let metaChanged = false;

    const rows = await Promise.all(
      images.map(async (img) => {
        const target = img.target || {};
        const name = img.name || '';
        const digest = target.digest || '';
        const updatedAt = img.updatedAt ?? img.updated_at;
        const createdAt = img.createdAt ?? img.created_at;
        const containerdUpdated =
          protoTimestampToIso(updatedAt) ||
          protoTimestampToIso(createdAt) ||
          null;

        /** Use the pinned timestamp when the digest still matches — otherwise adopt containerd's value. */
        let updated = containerdUpdated;
        const entry = meta[name];
        if (entry && entry.digest === digest && entry.updatedAt) {
          updated = entry.updatedAt;
        } else if (digest) {
          meta[name] = { digest, updatedAt: containerdUpdated };
          metaChanged = true;
        }

        /** Descriptor `target.size` is the top-level manifest/index JSON blob — a few KB. Prefer summed layer + config sizes. */
        const compressedTotal = await compressedBlobSizeForImageName(name);
        const size =
          compressedTotal != null ? compressedTotal : Number(target.size) || 0;
        return {
          name,
          digest,
          size,
          /** ISO 8601 or null if containerd sent no timestamps */
          updated,
        };
      }),
    );

    const currentNames = new Set(images.map((i) => i.name).filter(Boolean));
    for (const key of Object.keys(meta)) {
      if (!currentNames.has(key)) {
        delete meta[key];
        metaChanged = true;
      }
    }
    if (metaChanged) await writeImageMeta(meta);

    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
  });
}
