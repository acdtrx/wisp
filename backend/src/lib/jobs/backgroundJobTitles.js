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

export function titleForContainerBackup(name) {
  return `Backup ${name}`;
}

export function titleForContainerRestore(name) {
  return `Restore ${name}`;
}

export const TITLE_IMAGE_UPDATE_CHECK_ALL = 'Check OCI image updates';
export function titleForImageUpdateCheckSingle(ref) {
  const shortRef = ref.length > 48 ? `${ref.slice(0, 45)}…` : ref;
  return `Check ${shortRef}`;
}

export const titleForVmStart = (name) => `Start ${name}`;
export const titleForVmForceStop = (name) => `Force stop ${name}`;
export const titleForVmDelete = (name) => `Delete ${name}`;
export const titleForVmRestore = (newName) => `Restore ${newName}`;
export const TITLE_OS_UPDATE_CHECK = 'Check for OS updates';
export const TITLE_OS_UPGRADE = 'Install OS updates';
export const titleForBridgeCreate = (name) => `Create bridge ${name}`;
export const titleForBridgeDelete = (name) => `Delete bridge ${name}`;
export const titleForUnmount = (label) => `Unmount ${label}`;
export const titleForMountDelete = (label) => `Remove ${label}`;
export const titleForSelfUpdate = (version) => `Update Wisp to ${version}`;
export const titleForContainerStart = (name) => `Start ${name}`;
export const titleForContainerStop = (name) => `Stop ${name}`;
export const titleForContainerRestart = (name) => `Restart ${name}`;
export const titleForContainerDelete = (name) => `Delete ${name}`;
export const titleForContainerMountDelete = (name, mount) => `Remove mount ${mount} from ${name}`;
export const titleForContainerMountDataDelete = (name, mount) => `Delete data of ${mount} in ${name}`;
export const titleForContainerImageDelete = (ref) => `Delete image ${ref}`;
export const titleForContainerRestoreAsNew = (newName) => `Restore ${newName}`;
export const titleForZipExtract = (name, mount) => `Extract zip into ${mount} of ${name}`;
export const titleForContainerDeploy = (name) => `Deploy ${name}`;
export const titleForContainerImageUpdate = (name) => `Update image of ${name}`;

export const TITLE_LIBRARY_UBUNTU_CLOUD = 'Ubuntu Cloud Image';
export const TITLE_LIBRARY_ARCH_CLOUD = 'Arch Linux Cloud Image';
export const TITLE_LIBRARY_HAOS = 'Home Assistant';
