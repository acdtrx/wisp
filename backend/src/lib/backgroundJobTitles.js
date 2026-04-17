/**
 * Display titles for background jobs — mirrors frontend rules (ImageLibrary URL truncation, etc.).
 */

/** Same rule as frontend ImageLibrary: length > 56 → first 53 chars + ellipsis. */
export function titleForLibraryDownloadUrl(url) {
  if (url.length > 56) {
    return `${url.slice(0, 53)}…`;
  }
  return url;
}

export function titleForVmCreate(name) {
  return `Create ${name}`;
}

export function titleForBackup(vmName) {
  return `Backup ${vmName}`;
}

export function titleForContainerCreate(name) {
  return `Create ${name}`;
}

export const TITLE_IMAGE_UPDATE_CHECK_ALL = 'Check OCI image updates';
export function titleForImageUpdateCheckSingle(ref) {
  const shortRef = ref.length > 48 ? `${ref.slice(0, 45)}…` : ref;
  return `Check ${shortRef}`;
}

export const TITLE_LIBRARY_UBUNTU_CLOUD = 'Ubuntu Cloud Image';
export const TITLE_LIBRARY_ARCH_CLOUD = 'Arch Linux Cloud Image';
export const TITLE_LIBRARY_HAOS = 'Home Assistant';
