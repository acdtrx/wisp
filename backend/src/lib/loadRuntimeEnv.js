import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { createAppError } from './appErrors.js';

/**
 * Every WISP_* variable the backend reads, with its check (CODING-RULES §4). An
 * empty value means unset, as it does for the code that reads it. Other keys in
 * runtime.env are left alone: systemd's EnvironmentFile= shares the file, and
 * GITHUB_TOKEN / NODE_ENV are not Wisp's to police.
 */
const WISP_KEYS = {
  WISP_PORT: checkPort,
  WISP_CONFIG_PATH: checkAbsolute,
  WISP_DEFAULT_BRIDGE: checkInterfaceName, // existence: networking, at startup
  WISP_CONTAINERD_SOCK: checkAbsolute,
  WISP_ALLOWED_WS_ORIGINS: checkOriginList,
  WISP_UPDATE_REPO: checkRepo,
  WISP_ROUTE_ACCESS_REPORT: checkFlag,
  WISP_ACME_DIRECTORY: checkHttpsUrl,
};

/**
 * WISP_* keys earlier releases wrote and no release reads any more. Migration
 * 0007 removes them; until it has, the start loads the file tolerating
 * exactly these (bootRuntimeEnv.js), and checks it strictly once the
 * migrations have run (checkRuntimeEnvFile).
 */
/** The ports of the frontend/backend split (removed by migration 0007). */
export const RETIRED_PORT_KEYS = Object.freeze(['WISP_BACKEND_PORT', 'WISP_FRONTEND_PORT']);
/** The helper-path overrides: a helper is only ever /usr/local/bin's (removed by migration 0014). */
export const RETIRED_HELPER_PATH_KEYS = Object.freeze([
  'WISP_POWER_SCRIPT', 'WISP_DMIDECODE_SCRIPT', 'WISP_SMARTCTL_SCRIPT', 'WISP_NETNS_SCRIPT', 'WISP_CNI_SCRIPT',
]);
/** The CNI folders: wisp-cni names the plugins' and writes the network itself (removed by migration 0015). */
export const RETIRED_CNI_DIR_KEYS = Object.freeze(['WISP_CNI_BIN_DIR', 'WISP_CNI_CONF_DIR']);
/** Every retired key: tolerated at the start, until its migration has removed it. */
export const RETIRED_ENV_KEYS = Object.freeze([...RETIRED_PORT_KEYS, ...RETIRED_HELPER_PATH_KEYS, ...RETIRED_CNI_DIR_KEYS]);

/** A line assigning one of `keys` (optionally `export`-prefixed), or null. */
export function retiredKeyOfLine(line, keys = RETIRED_ENV_KEYS) {
  const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
  return m && keys.includes(m[1]) ? m[1] : null;
}

function checkPort(v) {
  if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 65535) return 'must be a port number (1–65535)';
  return null;
}

function checkAbsolute(v) {
  return isAbsolute(v) ? null : 'must be an absolute path';
}

function checkInterfaceName(v) {
  return /^[A-Za-z0-9_.:-]{1,15}$/.test(v) ? null : 'must be a network interface name';
}

function checkOriginList(v) {
  for (const entry of v.split(',').map((e) => e.trim())) {
    let origin = null;
    try {
      origin = new URL(entry).origin;
    } catch { /* not a URL — reported below */ }
    if (!entry || origin !== entry) return `"${entry}" is not an origin (scheme://host[:port])`;
  }
  return null;
}

function checkRepo(v) {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v) ? null : 'must be <owner>/<repo>';
}

function checkHttpsUrl(v) {
  let url = null;
  try {
    url = new URL(v);
  } catch { /* not a URL — reported below */ }
  return url?.protocol === 'https:' ? null : 'must be an https URL';
}

function checkFlag(v) {
  return v === '0' || v === '1' ? null : 'must be 0 or 1';
}

function envInvalid(message) {
  return createAppError('RUNTIME_ENV_INVALID', message);
}

/**
 * Parse runtime.env text into `[{ key, value }]`. Strict (CODING-RULES §4): a
 * line that isn't `KEY=value`, a key given twice, or an unknown WISP_* key throws
 * RUNTIME_ENV_INVALID naming the line. `tolerateKeys` skips the lines assigning
 * those keys instead, and nothing else — for the start, which must
 * load a file an older release wrote before migration 0007 removes them.
 */
export function parseRuntimeEnvText(content, { tolerateKeys = [] } = {}) {
  const entries = [];
  const seen = new Set();
  content.split('\n').forEach((line, i) => {
    const trimmed = line.replace(/\r$/, '').trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    if (tolerateKeys.length > 0 && retiredKeyOfLine(trimmed, tolerateKeys)) return;
    const where = `runtime.env line ${i + 1}`;
    const fail = (message) => {
      throw envInvalid(`${where}: ${message}`);
    };
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) return fail(`expected KEY=value, got ${JSON.stringify(trimmed)}`);
    const key = match[1];
    if (key.startsWith('WISP_') && !Object.hasOwn(WISP_KEYS, key)) return fail(`unknown key ${key}`);
    if (seen.has(key)) return fail(`${key} is set twice`);
    seen.add(key);
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    entries.push({ key, value });
  });
  return entries;
}

/**
 * Load KEY=value pairs from <projectRoot>/config/runtime.env into process.env.
 * Only sets keys that are not already present in process.env (under systemd,
 * EnvironmentFile= has set them already). File is optional; no-op if missing.
 * Strict, but for `tolerateKeys` (see parseRuntimeEnvText).
 *
 * Returns its warnings (none, or the file's permission bits exceeding 0o600 —
 * runtime.env holds secrets like GITHUB_TOKEN), which the start logs once its
 * logger exists. It only warns, not refuses: install/setup scripts also chmod
 * the file at write time.
 * @returns {string[]}
 */
export function loadRuntimeEnv(projectRoot, { tolerateKeys = [] } = {}) {
  const envPath = resolve(projectRoot, 'config/runtime.env');
  const warnings = [];
  if (!existsSync(envPath)) return warnings;
  try {
    const st = statSync(envPath);
    /* mask out file-type bits and check group/other bits */
    if ((st.mode & 0o077) !== 0) {
      const octal = (st.mode & 0o777).toString(8);
      warnings.push(`[runtime.env] permissions are 0o${octal} — should be 0600 (chmod 600 ${envPath})`);
    }
  } catch {
    /* stat may fail in unusual mounts; the readFileSync below will surface a real failure */
  }
  for (const { key, value } of parseRuntimeEnvText(readFileSync(envPath, 'utf8'), { tolerateKeys })) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return warnings;
}

/**
 * Check every WISP_* variable the environment sets — from runtime.env or
 * anywhere else — against its rule. Throws RUNTIME_ENV_INVALID naming the first
 * bad one.
 */
export function checkRuntimeEnv(env = process.env) {
  for (const [key, check] of Object.entries(WISP_KEYS)) {
    const value = env[key];
    if (value === undefined || value === '') continue;
    const problem = check(value);
    if (problem) throw envInvalid(`${key}: ${problem}`);
  }
}

/**
 * Parse <projectRoot>/config/runtime.env strictly, retired keys included. The
 * start's check once the migrations have run; throws RUNTIME_ENV_INVALID naming
 * the line. A missing file is fine.
 */
export function checkRuntimeEnvFile(projectRoot) {
  const envPath = resolve(projectRoot, 'config/runtime.env');
  if (!existsSync(envPath)) return;
  parseRuntimeEnvText(readFileSync(envPath, 'utf8'));
}
