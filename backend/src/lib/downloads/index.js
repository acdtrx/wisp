/**
 * Downloads module facade: the one home for outbound HTTP. undici and the
 * global `fetch` are fenced to this module (CODING-RULES §7).
 *
 * Two fetches: `ssrfSafeFetch` for every URL from user input or a public
 * source (private and loopback addresses refused, each redirect re-checked),
 * and `fetchOperatorEndpoint` for an endpoint only the operator sets, the OIDC
 * issuer (private addresses allowed, no redirect followed). On top of them: the
 * URL downloads into the library, the per-source helpers (Ubuntu cloud, Arch
 * cloud, HAOS) and the file-type detector.
 */
export {
  isPrivateIPv4,
  isPrivateIPv6,
  isAllowedUrl,
  checkUrl,
  downloadToLibrary,
  ssrfSafeFetch,
  downloadWithProgress,
} from './downloadFromUrl.js';

export { fetchOperatorEndpoint } from './operatorEndpoint.js';

export {
  openUniqueFile,
  writeResponseToFile,
  streamResponseToFile,
} from './downloadUtils.js';

export { downloadAndDecompressHaos, getLatestHaosAsset } from './downloadHaos.js';
export { downloadUbuntuCloudImage } from './downloadUbuntuCloud.js';
export { downloadArchCloudImage, ARCH_CLOUD_IMAGE_URL } from './downloadArchCloud.js';

export { detectType } from './fileTypes.js';
