/**
 * The `wisp` CLI's version check (docs/specs/CLI.md, Version check): a CLI
 * sends its version with every request, and a Wisp of another version
 * refuses the request before the route's handler. Exact match. A request
 * without the header is not checked, since other clients send none, and the
 * public routes (the CLI's own downloads among them) are never checked.
 *
 * It runs after the auth hook: a refusal of the version then means the token
 * was taken, which lets `wisp login` save a profile it can `wisp update` from.
 */
import { createAppError } from './appErrors.js';
import { routeAuthLevel } from './auth.js';
import { getCurrentVersion } from './wispUpdate.js';

const CLI_VERSION_HEADER = 'wisp-cli-version';

/** The `onRequest` hook; `version` is this Wisp's, read once (an update restarts the process). */
export function createCliVersionHook(version = getCurrentVersion()) {
  return async (request) => {
    if (request.is404) return;
    if (routeAuthLevel(request.routeOptions.config) === 'public') return;
    const sent = request.headers[CLI_VERSION_HEADER];
    if (sent === undefined || sent === version) return;
    throw createAppError(
      'CLI_VERSION_MISMATCH',
      `This wisp CLI is ${sent} and this Wisp is ${version}: the two must be the same version.`,
    );
  };
}
