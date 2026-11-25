/**
 * Outbound module facade: the one home of outbound HTTP, and nothing else.
 * undici and the global `fetch` are fenced to its two fetch files
 * (CODING-RULES §7).
 *
 * `ssrfSafeFetch` for every URL from user input or a public source (private
 * and loopback addresses refused, each redirect re-checked), and
 * `fetchOperatorEndpoint` for an endpoint only the operator sets, the OIDC
 * issuer (private addresses allowed, no redirect followed). What speaks a
 * remote API through them lives with its own subject.
 */
export {
  isPrivateIPv4,
  isPrivateIPv6,
  isAllowedUrl,
  ssrfSafeFetch,
} from './ssrfSafeFetch.js';

export { fetchOperatorEndpoint } from './operatorEndpoint.js';
