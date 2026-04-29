import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Load KEY=value pairs from <projectRoot>/config/runtime.env into process.env.
 * Only sets keys that are not already present in process.env.
 * File is optional; no-op if missing.
 *
 * Warns to stderr when the file's permission bits exceed 0o600 — runtime.env
 * holds secrets like GITHUB_TOKEN. We intentionally only warn (not refuse)
 * because boot is the worst time to fail; install/setup scripts also chmod
 * the file at write time.
 */
export function loadRuntimeEnv(projectRoot) {
  const envPath = resolve(projectRoot, 'config/runtime.env');
  if (!existsSync(envPath)) return;
  try {
    const st = statSync(envPath);
    /* mask out file-type bits and check group/other bits */
    if ((st.mode & 0o077) !== 0) {
      const octal = (st.mode & 0o777).toString(8);
      // Bootstrap log: Pino isn't initialized yet during loadRuntimeEnv.
      console.warn(
        `[runtime.env] permissions are 0o${octal} — should be 0600 (chmod 600 ${envPath})`,
      );
    }
  } catch {
    /* stat may fail in unusual mounts; the readFileSync below will surface a real failure */
  }
  const content = readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.replace(/\r$/, '').trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) continue;
    const key = match[1];
    if (process.env[key] !== undefined) continue;
    let val = match[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}
