/**
 * Normalize an OCI image reference for containerd the way Docker does
 * (distribution/reference `splitDockerDomain`): the first path component is a
 * registry host only when it contains '.' or ':', is 'localhost', or has an
 * uppercase letter; otherwise the ref is on Docker Hub, and a single-component
 * Hub repository gets the `library/` prefix. `index.docker.io` is rewritten to
 * `docker.io`. Tags and digests pass through untouched (no `:latest` is added).
 *
 *   caddy:2           → docker.io/library/caddy:2
 *   user/app          → docker.io/user/app
 *   nas:5000/app      → nas:5000/app
 *   localhost/app:v1  → localhost/app:v1
 *   ghcr.io/o/app     → ghcr.io/o/app
 */
export function normalizeImageRef(ref) {
  if (!ref || typeof ref !== 'string') return '';
  const slash = ref.indexOf('/');
  const first = slash === -1 ? '' : ref.slice(0, slash);
  const isRegistry = slash !== -1
    && (/[.:]/.test(first) || first === 'localhost' || first.toLowerCase() !== first);

  let domain = 'docker.io';
  let remainder = ref;
  if (isRegistry) {
    domain = first === 'index.docker.io' ? 'docker.io' : first;
    remainder = ref.slice(slash + 1);
  }
  if (domain === 'docker.io' && !remainder.includes('/')) remainder = `library/${remainder}`;
  return `${domain}/${remainder}`;
}

/**
 * A ref whose registry host is `localhost`: an image of this host's own, which
 * came from no registry and is never pulled. `localhost:5000/app` names a
 * registry on this host, and is pulled like any other.
 */
export function isLocalImageRef(ref) {
  return normalizeImageRef(ref).startsWith('localhost/');
}

/**
 * The name an uploaded image is stored under: the name its archive carries,
 * with the registry host replaced by `localhost` (Docker Hub's `library/`
 * dropped with it). A name already under `localhost/` is kept.
 *
 *   myapp:v1                      → localhost/myapp:v1
 *   docker.io/library/nginx:1.27  → localhost/nginx:1.27
 *   docker.io/me/app:1            → localhost/me/app:1
 *   ghcr.io/me/app:2              → localhost/me/app:2
 *   localhost/app:dev             → localhost/app:dev
 */
export function localImageNameFor(archiveName) {
  const normalized = normalizeImageRef(archiveName);
  if (normalized.startsWith('localhost/')) return normalized;
  const slash = normalized.indexOf('/');
  const domain = normalized.slice(0, slash);
  let path = normalized.slice(slash + 1);
  if (domain === 'docker.io' && path.startsWith('library/')) path = path.slice('library/'.length);
  return `localhost/${path}`;
}

/**
 * containerd cannot rename an image on import: an import stores each image
 * under a name of Wisp's own, under this prefix, until it has named it. Those
 * names are no image of the library's: never listed, used or deleted by name.
 */
export const IMAGE_IMPORT_NAME_PREFIX = 'localhost/wisp-import-';

/** Whether `name` is one an import works under while it runs. */
export function isImageImportWorkName(name) {
  return typeof name === 'string' && name.startsWith(IMAGE_IMPORT_NAME_PREFIX);
}
