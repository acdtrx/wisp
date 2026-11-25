/**
 * Downloads module facade: the image downloads into the library, through the
 * SSRF-guarded fetch of lib/outbound — a URL, and the sources Wisp knows (the
 * per-source helpers: Ubuntu cloud, Arch cloud, HAOS) — with the file-type
 * detector and the response-to-file writers.
 */
export {
  checkUrl,
  downloadToLibrary,
  downloadWithProgress,
} from './downloadFromUrl.js';

export {
  openUniqueFile,
  writeResponseToFile,
  streamResponseToFile,
} from './downloadUtils.js';

export { downloadAndDecompressHaos, getLatestHaosAsset } from './downloadHaos.js';
export { downloadUbuntuCloudImage } from './downloadUbuntuCloud.js';
export { downloadArchCloudImage, ARCH_CLOUD_IMAGE_URL } from './downloadArchCloud.js';

export { detectType } from './fileTypes.js';
