/**
 * Deleting an OCI image from containerd (wisp namespace), after checking no
 * Wisp container uses it.
 */
import { getClient, callUnary, containerError, isWispError, wrapContainerError } from './containerManagerConnection.js';
import { findContainersUsingImage } from './containerManagerList.js';

/**
 * The checks an image delete makes first, quick and without side effects: a
 * reference (INVALID_CONTAINER_IMAGE_REF), no Wisp container using it
 * (CONTAINER_IMAGE_IN_USE; a list or config that cannot be read refuses it
 * with its own code), the image present (CONTAINER_IMAGE_NOT_FOUND).
 * Returns the trimmed name.
 */
export async function assertContainerImageDeletable(ref) {
  if (!ref || typeof ref !== 'string' || !ref.trim()) {
    throw containerError('INVALID_CONTAINER_IMAGE_REF', 'Image reference is required');
  }
  const imageName = ref.trim();

  let users;
  try {
    users = await findContainersUsingImage(imageName);
  } catch (err) {
    throw wrapContainerError(isWispError(err) ? err.code : 'INTERNAL_ERROR', `Cannot tell whether image "${imageName}" is in use`, err);
  }
  if (users.length > 0) {
    const list = users.join(', ');
    throw containerError(
      'CONTAINER_IMAGE_IN_USE',
      `Image is in use by container(s): ${list}`,
      list,
    );
  }
  try {
    await callUnary(getClient('images'), 'get', { name: imageName });
  } catch (err) {
    if (err?.code === 'CONTAINER_NOT_FOUND') {
      throw containerError('CONTAINER_IMAGE_NOT_FOUND', `Image not found: ${imageName}`, err.raw ?? err.message);
    }
    throw err;
  }
  return imageName;
}

/**
 * Delete an image from containerd by its exact listed name (as
 * `listContainerImages` returns it) — never normalized, so a local-only name
 * like `myapp:v1` deletes that image rather than a `docker.io/library/` twin.
 * Blocks if any Wisp container still references it.
 */
export async function deleteContainerImage(ref) {
  const imageName = await assertContainerImageDeletable(ref);
  try {
    // sync: true waits for the garbage collection of the image's content and snapshots.
    await callUnary(getClient('images'), 'delete', { name: imageName, sync: true }, { deadlineMs: 2 * 60_000 });
  } catch (err) {
    if (err?.code === 'CONTAINER_NOT_FOUND') {
      throw containerError(
        'CONTAINER_IMAGE_NOT_FOUND',
        `Image not found: ${imageName}`,
        err.raw ?? err.message,
      );
    }
    throw err;
  }
}
