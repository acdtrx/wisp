import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

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
  WISP_POWER_SCRIPT: checkExecutable,
  WISP_DMIDECODE_SCRIPT: checkExecutable,
  WISP_SMARTCTL_SCRIPT: checkExecutable,
  WISP_NETNS_SCRIPT: checkExecutable,
  WISP_CNI_SCRIPT: checkExecutable,
  WISP_CNI_BIN_DIR: checkAbsolute,
  WISP_CNI_CONF_DIR: checkAbsolute,
  WISP_CONTAINERD_SOCK: checkAbsolute,
  WISP_ALLOWED_WS_ORIGINS: checkOriginList,
  WISP_UPDATE_REPO: checkRepo,
  WISP_ROUTE_ACCESS_REPORT: checkFlag,
};

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

function checkExecutable(v) {
  if (!isAbsolute(v)) return 'must be an absolute path';
  try {
    accessSync(v, constants.X_OK);
    return null;
  } catch {
    return `${v} is not an executable file`;
  }
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

function checkFlag(v) {
  return v === '0' || v === '1' ? null : 'must be 0 or 1';
}

function envInvalid(message) {
  const err = new Error(message);
  err.code = 'RUNTIME_ENV_INVALID';
  return err;
}

/**
 * Parse runtime.env text into `[{ key, value }]`. Strict (CODING-RULES §4): a
 * line that isn't `KEY=value`, a key given twice, or an unknown WISP_* key throws
 * RUNTIME_ENV_INVALID naming the line. `lenient` skips those lines instead — only
 * for the migration runner's config repair, which must read a file an older
 * release wrote before it can clean it (backend/scripts/configRepair.mjs).
 */
export function parseRuntimeEnvText(content, { lenient = false } = {}) {
  const entries = [];
  const seen = new Set();
  content.split('\n').forEach((line, i) => {
    const trimmed = line.replace(/\r$/, '').trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const where = `runtime.env line ${i + 1}`;
    const fail = (message) => {
      if (!lenient) throw envInvalid(`${where}: ${message}`);
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
 * Strict unless `lenient` (see parseRuntimeEnvText).
 *
 * Warns to stderr when the file's permission bits exceed 0o600 — runtime.env
 * holds secrets like GITHUB_TOKEN. We intentionally only warn (not refuse):
 * install/setup scripts also chmod the file at write time.
 */
export function loadRuntimeEnv(projectRoot, { lenient = false } = {}) {
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
  for (const { key, value } of parseRuntimeEnvText(readFileSync(envPath, 'utf8'), { lenient })) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
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
