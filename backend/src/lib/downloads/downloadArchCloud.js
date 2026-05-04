/**
 * Download latest Arch Linux x86_64 cloud image (qcow2) from pkgbuild mirrors.
 * URL pattern documented at https://wiki.archlinux.org/title/Arch_Linux_on_a_VPS
 */

import { downloadToLibrary } from './downloadFromUrl.js';

export const ARCH_CLOUD_IMAGE_URL =
  'https://fastly.mirror.pkgbuild.com/images/latest/Arch-Linux-x86_64-cloudimg.qcow2';

/**
 * Download the image to the library. onProgress(percent).
 * Returns { name, type, size, modified }.
 */
export async function downloadArchCloudImage(onProgress) {
  return downloadToLibrary(ARCH_CLOUD_IMAGE_URL, onProgress);
}
