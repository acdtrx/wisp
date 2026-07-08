/**
 * Zot OCI Registry app module.
 * Manages zot config.json, htpasswd auth, OIDC single sign-on, and persistent
 * registry storage.
 *
 * zot has no user table. Both auth paths resolve a login to a bare *identity string*,
 * and that string is the only thing tying together an access-control policy, an API key,
 * and a session:
 *   - htpasswd → the username in the file (basic auth; what `docker login` speaks).
 *   - OIDC     → the value of one claim from the ID token (browser redirect flow).
 * The two are the same user iff the strings are equal, which is why the username claim
 * is configurable (see DEFAULT_USERNAME_CLAIM). They are independent code paths in zot's
 * `basicAuthn`, so htpasswd keeps working when the identity provider is down.
 */
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

import { createAppError as containerError } from '../routeErrors.js';

const CONFIG_PATH = '/etc/zot/config.json';
const HTPASSWD_PATH = '/etc/zot/htpasswd';
const SESSION_KEYS_PATH = '/etc/zot/session-keys.json';

/** zot only recognises a fixed set of provider keys; `oidc` is its generic OpenID Connect
 *  provider (the others are google/gitlab/github, which have bespoke handling). Any
 *  standards-compliant IdP — Pocket ID, Keycloak, authentik — goes under this key. */
const OIDC_PROVIDER_KEY = 'oidc';

/** zot's own default is `email`. We default to `preferred_username` so that a short
 *  htpasswd username and the SSO identity are the same string out of the box — otherwise
 *  the same person is two unrelated identities and their access-control policy, API keys
 *  and UI bookmarks don't carry across. */
const DEFAULT_USERNAME_CLAIM = 'preferred_username';
const DEFAULT_SCOPES = ['openid', 'profile', 'email'];

/** Session cookie keys, per gorilla/securecookie: a 64-byte HMAC key and a 32-byte AES-256
 *  key. base64url of 48/24 raw bytes lands exactly on those lengths with no padding.
 *  When the keys file is absent zot invents random keys at boot, silently dropping every
 *  browser session on each restart — and Wisp restarts zot on every config save. So we
 *  mint them once and persist them in appConfig; they are never rotated in place. */
const SESSION_HASH_KEY_BYTES = 48;
const SESSION_ENCRYPT_KEY_BYTES = 24;

/**
 * Hash a password using SHA-512 crypt. zot's htpasswd reader sniffs the hash prefix and
 * accepts `$2a$`/`$2b$`/`$2y$` (bcrypt), `$5$` (SHA-256) and `$6$` (SHA-512) — its docs
 * claim bcrypt-only, but `pkg/api/htpasswd.go` disagrees.
 * @param {string} password
 * @returns {Promise<string>}
 */
function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const proc = spawn('openssl', ['passwd', '-6', '-stdin'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    proc.on('error', (err) => reject(containerError('INVALID_APP_CONFIG', 'Failed to hash password', err.message)));
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(containerError('INVALID_APP_CONFIG', 'Failed to hash password', stderr || `openssl exited ${code}`));
    });
    proc.stdin.end(password, 'utf8');
  });
}

function defaultOidcConfig() {
  return {
    enabled: false,
    name: '',
    issuer: '',
    clientId: '',
    clientSecret: '',
    scopes: [...DEFAULT_SCOPES],
    usernameClaim: DEFAULT_USERNAME_CLAIM,
  };
}

function getDefaultAppConfig() {
  return {
    users: [],
    externalUrl: '',
    oidc: defaultOidcConfig(),
  };
}

function trimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** Absolute http(s) URL, no trailing slash. */
function normalizeUrl(raw, field) {
  const value = trimmedString(raw);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw containerError('INVALID_APP_CONFIG', `${field} must be a valid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw containerError('INVALID_APP_CONFIG', `${field} must be an http:// or https:// URL`);
  }
  return value.replace(/\/+$/, '');
}

function normalizeScopes(raw) {
  if (raw == null) return [...DEFAULT_SCOPES];
  if (!Array.isArray(raw)) {
    throw containerError('INVALID_APP_CONFIG', 'oidc.scopes must be an array');
  }
  const seen = new Set();
  for (const s of raw) {
    const scope = trimmedString(s);
    if (!scope) continue;
    if (/\s/.test(scope)) {
      throw containerError('INVALID_APP_CONFIG', `oidc.scopes entry "${scope}" must not contain whitespace`);
    }
    seen.add(scope);
  }
  return [...seen];
}

/**
 * Validate the users table, recovering hashes for users the client didn't retype.
 *
 * `maskSecrets` strips every hash before appConfig reaches the browser, so an unchanged
 * user round-trips as a bare `{ username }`. Without the merge below, adding a second
 * user (or deleting one) would demand the password of every *other* user. Hashes are only
 * ever sourced from the stored config — an API caller cannot inject one.
 */
function validateUsers(users, oldAppConfig) {
  if (!Array.isArray(users)) {
    throw containerError('INVALID_APP_CONFIG', 'users must be an array');
  }

  const storedHashes = new Map(
    (oldAppConfig?.users || [])
      .filter((u) => typeof u?.username === 'string' && typeof u?.hash === 'string')
      .map((u) => [u.username, u.hash]),
  );

  const seen = new Set();
  return users.map((u, i) => {
    if (!u || typeof u !== 'object') {
      throw containerError('INVALID_APP_CONFIG', `users[${i}] must be an object`);
    }
    const username = trimmedString(u.username);
    if (!username) {
      throw containerError('INVALID_APP_CONFIG', `users[${i}].username is required`);
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(username)) {
      throw containerError('INVALID_APP_CONFIG', `users[${i}].username "${username}" contains invalid characters`);
    }
    if (seen.has(username.toLowerCase())) {
      throw containerError('INVALID_APP_CONFIG', `Duplicate username "${username}"`);
    }
    seen.add(username.toLowerCase());

    const password = typeof u.password === 'string' && u.password !== '' ? u.password : undefined;
    // A hash is keyed by username, so a renamed user looks new and must supply a password.
    const hash = password ? undefined : storedHashes.get(username);
    if (!password && !hash) {
      throw containerError(
        'INVALID_APP_CONFIG',
        `users[${i}] ("${username}") is new or renamed — a password is required`,
      );
    }

    return { username, password, hash };
  });
}

function validateOidc(raw, oldAppConfig) {
  if (raw == null) return defaultOidcConfig();
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw containerError('INVALID_APP_CONFIG', 'oidc must be an object');
  }

  const enabled = raw.enabled === true;
  const name = trimmedString(raw.name);
  const clientId = trimmedString(raw.clientId);
  const usernameClaim = trimmedString(raw.usernameClaim) || DEFAULT_USERNAME_CLAIM;
  const scopes = normalizeScopes(raw.scopes);

  // maskSecrets replaces the secret with `{ isSet }`, so anything that isn't a non-empty
  // string means "unchanged" — carry the stored value forward rather than blanking it.
  const submittedSecret = typeof raw.clientSecret === 'string' ? raw.clientSecret : '';
  const clientSecret = submittedSecret !== '' ? submittedSecret : (oldAppConfig?.oidc?.clientSecret || '');

  // Keep whatever the user typed even while disabled, so toggling OIDC back on doesn't
  // make them re-enter the provider details. Only *enabling* it demands a complete set.
  if (!enabled) {
    const issuer = trimmedString(raw.issuer);
    return { enabled: false, name, issuer, clientId, clientSecret, scopes, usernameClaim };
  }

  if (!trimmedString(raw.issuer)) {
    throw containerError('INVALID_APP_CONFIG', 'oidc.issuer is required when OIDC is enabled');
  }
  const issuer = normalizeUrl(raw.issuer, 'oidc.issuer');
  if (!clientId) {
    throw containerError('INVALID_APP_CONFIG', 'oidc.clientId is required when OIDC is enabled');
  }
  if (!clientSecret) {
    throw containerError('INVALID_APP_CONFIG', 'oidc.clientSecret is required when OIDC is enabled');
  }
  if (!/^[A-Za-z0-9_.:-]+$/.test(usernameClaim)) {
    throw containerError('INVALID_APP_CONFIG', `oidc.usernameClaim "${usernameClaim}" is not a valid claim name`);
  }
  if (!scopes.includes('openid')) {
    throw containerError('INVALID_APP_CONFIG', 'oidc.scopes must include "openid"');
  }

  return { enabled: true, name, issuer, clientId, clientSecret, scopes, usernameClaim };
}

function validateAppConfig(appConfig, oldAppConfig = null) {
  if (!appConfig || typeof appConfig !== 'object' || Array.isArray(appConfig)) {
    throw containerError('INVALID_APP_CONFIG', 'appConfig must be an object');
  }

  const users = validateUsers(appConfig.users, oldAppConfig);
  const oidc = validateOidc(appConfig.oidc, oldAppConfig);

  // zot builds the OIDC redirect_uri from externalUrl; with it unset it falls back to
  // `http.address:port`, i.e. `0.0.0.0:5000` — an address no browser can be sent back to.
  // Requiring it turns a baffling login loop into a validation error.
  let externalUrl = '';
  if (trimmedString(appConfig.externalUrl)) {
    externalUrl = normalizeUrl(appConfig.externalUrl, 'externalUrl');
  } else if (oidc.enabled) {
    throw containerError(
      'INVALID_APP_CONFIG',
      'externalUrl is required when OIDC is enabled — it is the base of the redirect URI',
    );
  }

  // Never sourced from the caller; carried forward from disk, minted in generateDerivedConfig.
  const sessionKeys = oidc.enabled ? (oldAppConfig?.sessionKeys ?? null) : null;

  return { users, externalUrl, oidc, ...(sessionKeys ? { sessionKeys } : {}) };
}

function generateSessionKeys() {
  return {
    hashKey: randomBytes(SESSION_HASH_KEY_BYTES).toString('base64url'),
    encryptKey: randomBytes(SESSION_ENCRYPT_KEY_BYTES).toString('base64url'),
  };
}

/**
 * Build zot config.json. Keys under `openid.providers` are lowercase-concatenated
 * (`clientid`, not `clientId`) — zot reads its config through viper/mapstructure, which
 * derives them from the Go field names.
 */
function generateZotConfig({ users, oidc, externalUrl }) {
  const config = {
    distSpecVersion: '1.1.1',
    storage: {
      rootDirectory: '/var/lib/registry',
    },
    http: {
      address: '0.0.0.0',
      port: '5000',
    },
    extensions: {
      search: { enable: true },
      ui: { enable: true },
    },
  };

  if (externalUrl) {
    config.http.externalUrl = externalUrl;
  }

  const auth = {};

  if (users.length > 0) {
    auth.htpasswd = { path: HTPASSWD_PATH };
  }

  if (oidc.enabled) {
    auth.openid = {
      providers: {
        [OIDC_PROVIDER_KEY]: {
          name: oidc.name || 'SSO',
          issuer: oidc.issuer,
          clientid: oidc.clientId,
          clientsecret: oidc.clientSecret,
          scopes: oidc.scopes,
          claimmapping: { username: oidc.usernameClaim },
        },
      },
    };
    // `docker login` cannot follow a browser redirect, so an SSO-only identity has no way
    // to push without an API key: sign in to the web UI, mint a `zak_…` key, use it as the
    // basic-auth password. zot does *not* turn these on with OpenID — `basicAuthn` checks
    // `IsAPIKeyEnabled()` independently — and they live in MetaDB, which `extensions.search`
    // above provides.
    auth.apikey = true;
    auth.sessionKeysFile = SESSION_KEYS_PATH;
  }

  if (Object.keys(auth).length > 0) {
    config.http.auth = auth;
    // Anonymous pull; any authenticated identity — htpasswd or SSO — gets full access.
    config.http.accessControl = {
      repositories: {
        '**': {
          anonymousPolicy: ['read'],
          defaultPolicy: ['read', 'create', 'update', 'delete'],
        },
      },
    };
  }

  return JSON.stringify(config, null, 2) + '\n';
}

/**
 * Build htpasswd file content from users with hashed passwords.
 */
function generateHtpasswd(users) {
  return users.map((u) => `${u.username}:${u.hash}`).join('\n') + '\n';
}

async function generateDerivedConfig(appConfig) {
  // Hash any new passwords (users with password but no hash)
  const users = await Promise.all(appConfig.users.map(async (u) => {
    if (u.password) {
      const hash = await hashPassword(u.password);
      return { username: u.username, hash };
    }
    return { username: u.username, hash: u.hash };
  }));

  const oidc = appConfig.oidc ?? defaultOidcConfig();
  const externalUrl = appConfig.externalUrl || '';
  // Minted on first enable and persisted thereafter. Regenerating on every save would
  // sign every browser session out; see SESSION_HASH_KEY_BYTES.
  const sessionKeys = oidc.enabled ? (appConfig.sessionKeys ?? generateSessionKeys()) : null;

  const mounts = [
    { type: 'file', name: 'config-json', containerPath: CONFIG_PATH, readonly: true },
    { type: 'directory', name: 'registry', containerPath: '/var/lib/registry', readonly: false },
  ];

  const mountContents = {
    'config-json': generateZotConfig({ users, oidc, externalUrl }),
  };

  if (users.length > 0) {
    mounts.push({ type: 'file', name: 'htpasswd', containerPath: HTPASSWD_PATH, readonly: true });
    mountContents.htpasswd = generateHtpasswd(users);
  }

  if (sessionKeys) {
    mounts.push({ type: 'file', name: 'session-keys', containerPath: SESSION_KEYS_PATH, readonly: true });
    mountContents['session-keys'] = JSON.stringify(sessionKeys, null, 2) + '\n';
  }

  // Store hashes back in appConfig so passwords aren't kept in plaintext
  const storedAppConfig = {
    users: users.map((u) => ({ username: u.username, hash: u.hash })),
    externalUrl,
    oidc,
    ...(sessionKeys ? { sessionKeys } : {}),
  };

  return { env: {}, mounts, mountContents, appConfig: storedAppConfig };
}

/**
 * Redact secrets for API responses. Built key-by-key rather than by spreading appConfig,
 * so a field added to the stored shape can never leak by omission — `sessionKeys` in
 * particular must never reach the browser.
 */
function maskSecrets(appConfig) {
  if (!appConfig) return appConfig;
  const oidc = appConfig.oidc ?? defaultOidcConfig();
  return {
    users: (appConfig.users || []).map((u) => ({
      username: u.username,
      hasPassword: !!u.hash,
    })),
    externalUrl: appConfig.externalUrl || '',
    oidc: {
      enabled: !!oidc.enabled,
      name: oidc.name || '',
      issuer: oidc.issuer || '',
      clientId: oidc.clientId || '',
      clientSecret: { isSet: !!oidc.clientSecret },
      scopes: oidc.scopes?.length ? oidc.scopes : [...DEFAULT_SCOPES],
      usernameClaim: oidc.usernameClaim || DEFAULT_USERNAME_CLAIM,
    },
  };
}

function getReloadCommand() {
  return null;
}

export const zotAppModule = {
  getDefaultAppConfig,
  validateAppConfig,
  generateDerivedConfig,
  maskSecrets,
  getReloadCommand,
};
