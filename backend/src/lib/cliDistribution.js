/**
 * The `wisp` CLI as this Wisp serves it (docs/specs/CLI.md, Getting it): the
 * binaries the install tree's `cli/` holds, one per platform, which
 * scripts/stage-release.sh builds there, and the two install scripts, each
 * served with the address of the Wisp to download from. A development checkout
 * holds the scripts and no binary.
 */
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAppError } from './appErrors.js';
import { getSettings } from './settings.js';

const CLI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../cli');

/** The platforms the CLI is built for, in CLI.md's order (scripts/stage-release.sh builds the same). */
export const CLI_PLATFORMS = Object.freeze([
  'darwin-arm64', 'darwin-amd64', 'linux-arm64', 'linux-amd64', 'windows-arm64', 'windows-amd64',
]);

const INSTALL_SCRIPTS = Object.freeze({
  'install.sh': { file: 'install.sh', type: 'text/x-shellscript; charset=utf-8' },
  'install.ps1': { file: 'install.ps1', type: 'text/plain; charset=utf-8' },
});

/** Where the script's address goes; the address a script is given is checked against ORIGIN_PATTERN. */
const URL_PLACEHOLDER = '{{wisp_url}}';

/**
 * An origin as the scripts take it inside single quotes: a scheme and a host
 * (a name, an IPv4 or a bracketed IPv6 address) with maybe a port, and no
 * character a shell or PowerShell would read.
 */
const ORIGIN_PATTERN = /^https?:\/\/(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

function binaryPath(platform) {
  return resolve(CLI_DIR, `wisp-${platform}`);
}

function hasBinary(platform) {
  return statSync(binaryPath(platform), { throwIfNoEntry: false })?.isFile() === true;
}

/** The platforms this install has a binary for. */
export function availableCliPlatforms() {
  return CLI_PLATFORMS.filter(hasBinary);
}

/**
 * The binary for `platform`, to stream as a download: `{ stream, size,
 * filename }`. A platform the CLI is not built for, or one this install
 * carries no binary for, is CLI_NOT_AVAILABLE.
 */
export function openCliBinary(platform) {
  const stat = CLI_PLATFORMS.includes(platform) ? statSync(binaryPath(platform), { throwIfNoEntry: false }) : null;
  if (!stat?.isFile()) {
    const known = CLI_PLATFORMS.includes(platform)
      ? 'this Wisp carries no CLI binaries (a development checkout)'
      : `the platforms are ${CLI_PLATFORMS.join(', ')}`;
    throw createAppError('CLI_NOT_AVAILABLE', `No wisp CLI for "${platform}": ${known}`);
  }
  const filename = platform.startsWith('windows-') ? `wisp-${platform}.exe` : `wisp-${platform}`;
  return { stream: createReadStream(binaryPath(platform)), size: stat.size, filename };
}

/**
 * The address the scripts and the install line name: the advertised URL's
 * origin when one is set (docs/specs/SETTINGS.md), else the one the request
 * came to. Null when neither is an origin the scripts can carry.
 */
export function cliBaseUrl({ advertisedUrl, protocol, host }) {
  if (!advertisedUrl && !host) return null;
  let origin = null;
  try {
    origin = new URL(advertisedUrl || `${protocol}://${host}`).origin;
  } catch {
    return null; // no Host header, or one that is no host: there is no address to name
  }
  return ORIGIN_PATTERN.test(origin) ? origin : null;
}

/** cliBaseUrl for a request: the advertised URL, else its scheme and Host. */
export async function requestCliBaseUrl(request) {
  const { advertisedUrl } = await getSettings();
  return cliBaseUrl({ advertisedUrl, protocol: request.protocol, host: request.headers.host });
}

/** The install script `name` (`install.sh`, `install.ps1`), downloading from `baseUrl`: `{ body, type }`. */
export function cliInstallScript(name, baseUrl) {
  const script = INSTALL_SCRIPTS[name];
  if (!ORIGIN_PATTERN.test(baseUrl)) {
    throw createAppError('BAD_REQUEST', 'The request names no address the install script can download from');
  }
  const template = readFileSync(resolve(CLI_DIR, script.file), 'utf8');
  return { body: template.replace(URL_PLACEHOLDER, baseUrl), type: script.type };
}
