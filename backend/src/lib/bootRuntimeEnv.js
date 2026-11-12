/**
 * Loads config/runtime.env into process.env when imported. index.js imports
 * it before every other project module: config.js resolves WISP_CONFIG_PATH
 * (and containerManager its socket path) as it loads, and ESM evaluates static
 * imports before the importing module's own code runs. Under systemd the
 * unit's EnvironmentFile= has set the same variables already; loadRuntimeEnv
 * never overrides one that is set.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRuntimeEnv } from './loadRuntimeEnv.js';

loadRuntimeEnv(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'));
