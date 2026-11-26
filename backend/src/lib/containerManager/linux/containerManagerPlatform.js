/**
 * The host's platform in an OCI image index: which of an index's manifests
 * this host runs, best first. Pull and the size reader choose the same one.
 */
export const OCI_ARCH = ({ x64: 'amd64', arm64: 'arm64', arm: 'arm' })[process.arch] || process.arch;

/** The host's platform as a transfer's filter and unpack name it. */
export const HOST_PLATFORM = OCI_ARCH === 'arm64'
  ? { os: 'linux', architecture: OCI_ARCH, variant: 'v8' }
  : { os: 'linux', architecture: OCI_ARCH };

/** `os/arch[/variant]`, or '' for a descriptor without a platform. */
export function formatPlatform(p) {
  if (!p?.os) return '';
  const os = p.os;
  const arch = p.architecture || '?';
  const v = p.variant ? `/${p.variant}` : '';
  return `${os}/${arch}${v}`;
}

/** Map registry architecture strings to OCI-normalized values (matches common image indexes). */
function normalizeOCIArchitecture(arch) {
  if (!arch || typeof arch !== 'string') return '';
  const a = arch.toLowerCase();
  if (a === 'x86_64' || a === 'x86-64') return 'amd64';
  if (a === 'aarch64') return 'arm64';
  return a;
}

/**
 * Higher = preferred when multiple descriptors match linux + host arch (variant tie-break).
 */
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
 * The descriptors of an OCI index / Docker manifest list that are Linux on the
 * host's architecture, the preferred variant first (then by digest, so the
 * choice is stable). Empty when none matches: never an arbitrary first entry,
 * which could be a Windows image on a multi-arch index.
 */
export function hostLinuxManifests(manifests) {
  if (!Array.isArray(manifests)) return [];
  return manifests
    .filter((m) => {
      const p = m.platform;
      if (!p) return false;
      if ((p.os || '').toLowerCase() !== 'linux') return false;
      return normalizeOCIArchitecture(p.architecture) === OCI_ARCH;
    })
    .sort((a, b) => {
      const d = variantPreference(b.platform) - variantPreference(a.platform);
      if (d !== 0) return d;
      return String(a.digest || '').localeCompare(String(b.digest || ''));
    });
}
