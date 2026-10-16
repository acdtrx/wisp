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
