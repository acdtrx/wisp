import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Load KEY=value pairs from <projectRoot>/config/runtime.env into process.env.
 * Only sets keys that are not already present in process.env.
 * File is optional; no-op if missing.
 */
export function loadRuntimeEnv(projectRoot) {
  const envPath = resolve(projectRoot, 'config/runtime.env');
  if (!existsSync(envPath)) return;
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
