/**
 * Loads config/runtime.env into process.env when imported. index.js imports
 * it before every other project module: config.js resolves WISP_CONFIG_PATH
 * (and containerManager its socket path) as it loads, and ESM evaluates static
 * imports before the importing module's own code runs. Under systemd the
 * unit's EnvironmentFile= has set the same variables already; loadRuntimeEnv
 * never overrides one that is set.
 *
 * Strict (CODING-RULES §4), but for the lines setting the retired keys, which
 * are not loaded from the file here (systemd's EnvironmentFile= may still set
 * them; nothing reads them): migration 0007 removes them, and the start checks
 * the file strictly once the migrations have run. Every WISP_* value is
 * checked here, so WISP_CONFIG_PATH (the config, and with it the ledger, the
 * migrations work on) never comes from a bad line.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkRuntimeEnv, loadRuntimeEnv, RETIRED_ENV_KEYS } from './loadRuntimeEnv.js';

/** What the load warned of, for main() to log once the start's logger exists. */
export const runtimeEnvWarnings = [];

try {
  runtimeEnvWarnings.push(...loadRuntimeEnv(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'), { tolerateKeys: RETIRED_ENV_KEYS }));
  checkRuntimeEnv();
} catch (err) {
  // Before any logger exists: stderr, which the journal keeps.
  process.stderr.write(`Failed to start: ${err.message}\n`);
  process.exit(1);
}
