/**
 * Downloads module facade. Bundles SSRF-safe URL downloads, the per-source helpers
 * (Ubuntu cloud, Arch cloud, HAOS), and the file-type detector.
 *
 * Sole consumer today is `routes/library.js`.
 */
export {
  isPrivateIPv4,
  isPrivateIPv6,
  isAllowedUrl,
  checkUrl,
  downloadToLibrary,
  ssrfSafeFetch,
} from './downloadFromUrl.js';

export {
  findUniqueFilename,
  streamResponseToFile,
  downloadWithProgress,
} from './downloadUtils.js';

export { downloadAndDecompressHaos, getLatestHaosAsset } from './downloadHaos.js';
export { downloadUbuntuCloudImage } from './downloadUbuntuCloud.js';
export { downloadArchCloudImage, ARCH_CLOUD_IMAGE_URL } from './downloadArchCloud.js';

export { detectType } from './fileTypes.js';
