/**
 * Zot OCI Registry app module.
 * Manages zot config.json, htpasswd auth, and persistent registry storage.
 */
import { spawn } from 'node:child_process';

import { createAppError as containerError } from '../routeErrors.js';

/**
 * Hash a password using SHA-512 crypt (compatible with htpasswd / zot).
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

function getDefaultAppConfig() {
  return {
    users: [],
  };
}

function validateAppConfig(appConfig) {
  if (!appConfig || typeof appConfig !== 'object' || Array.isArray(appConfig)) {
    throw containerError('INVALID_APP_CONFIG', 'appConfig must be an object');
  }

  const { users } = appConfig;

  if (!Array.isArray(users)) {
    throw containerError('INVALID_APP_CONFIG', 'users must be an array');
  }

  const seen = new Set();
  const normalizedUsers = users.map((u, i) => {
    if (!u || typeof u !== 'object') {
      throw containerError('INVALID_APP_CONFIG', `users[${i}] must be an object`);
    }
    const username = typeof u.username === 'string' ? u.username.trim() : '';
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

    // password is optional on update (omitted = keep existing hash)
    const password = u.password != null && typeof u.password === 'string' ? u.password : undefined;
    const hash = typeof u.hash === 'string' ? u.hash : undefined;

    if (!hash && !password) {
      throw containerError('INVALID_APP_CONFIG', `users[${i}] requires a password`);
    }

    return { username, password, hash };
  });

  return { users: normalizedUsers };
}

/**
 * Build zot config.json.
 */
function generateZotConfig(appConfig) {
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

  if (appConfig.users.length > 0) {
    config.http.auth = {
      htpasswd: {
        path: '/etc/zot/htpasswd',
      },
    };
    // Anonymous pull; authenticated users get full access
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

  const mounts = [
    { type: 'file', name: 'config-json', containerPath: '/etc/zot/config.json', readonly: true },
    { type: 'directory', name: 'registry', containerPath: '/var/lib/registry', readonly: false },
  ];

  const mountContents = {
    'config-json': generateZotConfig({ users }),
  };

  if (users.length > 0) {
    mounts.push({ type: 'file', name: 'htpasswd', containerPath: '/etc/zot/htpasswd', readonly: true });
    mountContents.htpasswd = generateHtpasswd(users);
  }

  // Store hashes back in appConfig so passwords aren't kept in plaintext
  const storedAppConfig = {
    users: users.map((u) => ({ username: u.username, hash: u.hash })),
  };

  return { env: {}, mounts, mountContents, appConfig: storedAppConfig };
}

function maskSecrets(appConfig) {
  if (!appConfig) return appConfig;
  return {
    ...appConfig,
    users: (appConfig.users || []).map((u) => ({
      username: u.username,
      hasPassword: !!u.hash,
    })),
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
