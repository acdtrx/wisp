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
 * A ref whose registry host is `localhost`, in any case and with no port
 * (`localhost./app` too, its fully qualified form): an image of this host's
 * own, which came from no registry and is never pulled. `localhost:5000/app`
 * names a registry on this host, and is pulled like any other.
 */
export function isLocalImageRef(ref) {
  if (typeof ref !== 'string') return false;
  const slash = ref.indexOf('/');
  if (slash <= 0) return false;
  return ref.slice(0, slash).replace(/\.$/, '').toLowerCase() === 'localhost';
}

/* The image reference grammar (distribution/reference), for a name and an
 * optional tag: an archive names its images by tag, never by digest. */
const DOMAIN_COMPONENT = '(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])';
const DOMAIN = `(?:${DOMAIN_COMPONENT}(?:\\.${DOMAIN_COMPONENT})*|\\[[a-fA-F0-9:]+\\])(?::[0-9]+)?`;
const PATH_COMPONENT = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*';
const TAG = '[\\w][\\w.-]{0,127}';
const TAGGED_NAME_RE = new RegExp(`^((?:${DOMAIN}/)?${PATH_COMPONENT}(?:/${PATH_COMPONENT})*)(?::${TAG})?$`);
const NAME_MAX = 255;

/** Whether `ref` is a valid image reference of a name and an optional tag (`app`, `ghcr.io/me/app:2`). */
export function isTaggedImageName(ref) {
  // The longest name and tag; past it the pattern is not tried at all.
  if (typeof ref !== 'string' || ref.length > NAME_MAX + 1 + 128) return false;
  const match = TAGGED_NAME_RE.exec(ref);
  return !!match && match[1].length <= NAME_MAX;
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
