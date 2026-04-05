/**
 * Normalize an OCI image reference for containerd (docker.io/library/ prefix when missing).
 * Matches pull/create behavior in containerManagerCreate.
 */
export function normalizeImageRef(ref) {
  if (!ref || typeof ref !== 'string') return '';
  if (!ref.includes('/')) return `docker.io/library/${ref}`;
  if (!ref.includes('.') && ref.split('/').length === 2) return `docker.io/${ref}`;
  return ref;
}
