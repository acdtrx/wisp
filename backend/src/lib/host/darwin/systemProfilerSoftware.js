/**
 * macOS software overview from `system_profiler -json SPSoftwareDataType` for GET /api/host.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 15_000;

/** Drop the last ` (…)` segment — typically the Apple build id (e.g. `(25D771280a)`), rarely useful in UI. */
function stripLastParenthetical(s) {
  return s.replace(/\s*\([^)]+\)\s*$/, '').trim();
}

/**
 * @returns {Promise<{
 *   osRelease: { prettyName: string, id: string, versionId: string | null } | null,
 *   kernel: string | null,
 *   hostname: string | null
 * } | null>}
 */
export async function getDarwinSoftwareFromProfiler() {
  const { stdout } = await execFileAsync(
    '/usr/sbin/system_profiler',
    ['-json', 'SPSoftwareDataType'],
    {
      timeout: TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
    },
  );

  const root = JSON.parse(stdout);
  const arr = root.SPSoftwareDataType;
  if (!Array.isArray(arr) || arr.length === 0) return null;

  const os = /** @type {Record<string, unknown>} */ (
    arr.find((x) => x && typeof x === 'object' && x._name === 'os_overview') || arr[0]
  );

  const osVersionRaw = typeof os.os_version === 'string' ? os.os_version.trim() : null;
  const osVersionDisplay = osVersionRaw ? stripLastParenthetical(osVersionRaw) : null;
  const kernelVersion = typeof os.kernel_version === 'string' ? os.kernel_version.trim() : null;
  const localHostName = typeof os.local_host_name === 'string' ? os.local_host_name.trim() : null;

  /** Semver-ish leading version from strings like "macOS 26.3.1 (a) (25D771280a)" */
  let versionId = null;
  if (osVersionRaw) {
    const sem = osVersionRaw.match(/(\d+\.\d+(?:\.\d+)?)/);
    versionId = sem ? sem[1] : null;
  }

  const osRelease = osVersionDisplay
    ? {
      prettyName: osVersionDisplay,
      id: 'macos',
      versionId,
    }
    : null;

  if (!osRelease && !kernelVersion && !localHostName) return null;

  return {
    osRelease,
    kernel: kernelVersion,
    hostname: localHostName,
  };
}
