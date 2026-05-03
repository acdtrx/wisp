/**
 * Tiny Samba app module.
 * Manages config.yaml + passwords.yaml generation, per-share bind mounts (with
 * optional storage-mount sourcing), and a tmpfs for /var/lib/samba runtime state.
 *
 * The image runs smbd as root so it can bind 445 and setuid per session — the
 * registry entry sets `requiresRoot: true` to flip on container.runAsRoot at create.
 *
 * Live reload via `tiny-samba reload` re-applies users / shares / passwords without
 * restarting smbd. Server-level changes (workgroup, netbiosName, dataUid) need a
 * task restart — `requiresRestartForChange` reports those.
 */
import { createAppError as containerError } from '../routeErrors.js';

const VALID_PROTOCOLS = ['SMB1', 'SMB2', 'SMB3'];
// Workgroup / NetBIOS name: Samba accepts up to 15 chars, alnum + underscore/hyphen.
const NETBIOS_REGEX = /^[A-Za-z0-9_-]{1,15}$/;
const WORKGROUP_REGEX = /^[A-Za-z0-9_-]{1,15}$/;
// SMB user names: lowercase, start with a letter, then [a-z0-9._-]
const USER_NAME_REGEX = /^[a-z][a-z0-9._-]*$/;
// SMB share names: DNS-label-shaped, lowercase
const SHARE_NAME_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
// Pre-computed NT hash format: $NT$ followed by 32 hex chars
const NT_HASH_REGEX = /^\$NT\$[0-9a-fA-F]{32}$/;

const TMPFS_STATE_SIZE_MIB = 64;

// AAPL/Finder integration toggle — sent to tiny-samba as `icon_model`.
// "TimeCapsule6,106" = enabled with the default model; "-" = disable AAPL extensions
// entirely (also disables vfs_fruit + streams_xattr, which is the workaround for the
// macOS "AFP_AfpInfo write failed: No such file or directory" upload error on filesystems
// where streams_xattr misbehaves).
const ICON_MODEL_DEFAULT = 'TimeCapsule6,106';
const ICON_MODEL_DISABLED = '-';

/**
 * Coerce an arbitrary identifier into a NetBIOS-safe name (15 chars, [A-Za-z0-9_-]).
 * Container names already match `[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}`, so we just strip
 * dots and truncate. Empty input falls back to the literal `tiny-samba`.
 */
function netbiosFromContainerName(containerName) {
  if (typeof containerName !== 'string') return 'tiny-samba';
  const cleaned = containerName.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 15);
  return cleaned || 'tiny-samba';
}

function getDefaultAppConfig(context = {}) {
  return {
    server: {
      workgroup: 'WORKGROUP',
      netbiosName: netbiosFromContainerName(context.containerName),
      dataUid: 1000,
      minProtocol: 'SMB3',
      iconModel: ICON_MODEL_DEFAULT,
    },
    users: [],
    shares: [],
  };
}

/**
 * Validate appConfig. Receives the previous appConfig (from container.json) so unchanged
 * passwords can be merged forward — the API masks passwords on output, so the frontend can't
 * round-trip them.
 *
 * @param {object} newConfig - incoming appConfig from PATCH body or create spec
 * @param {object|null} [oldConfig] - existing appConfig (for create flow this is null)
 */
function validateAppConfig(newConfig, oldConfig = null) {
  if (!newConfig || typeof newConfig !== 'object' || Array.isArray(newConfig)) {
    throw containerError('INVALID_APP_CONFIG', 'appConfig must be an object');
  }

  // ── server ────────────────────────────────────────────────────────
  const rawServer = newConfig.server || {};
  if (typeof rawServer !== 'object' || Array.isArray(rawServer)) {
    throw containerError('INVALID_APP_CONFIG', 'server must be an object');
  }
  const workgroup = typeof rawServer.workgroup === 'string' ? rawServer.workgroup.trim() : '';
  if (!WORKGROUP_REGEX.test(workgroup)) {
    throw containerError('INVALID_APP_CONFIG', 'server.workgroup must be 1–15 chars (alphanumeric, _ or -)');
  }
  const netbiosName = typeof rawServer.netbiosName === 'string' ? rawServer.netbiosName.trim() : '';
  if (!NETBIOS_REGEX.test(netbiosName)) {
    throw containerError('INVALID_APP_CONFIG', 'server.netbiosName must be 1–15 chars (alphanumeric, _ or -)');
  }
  const dataUidRaw = rawServer.dataUid;
  const dataUid = typeof dataUidRaw === 'string' ? Number(dataUidRaw.trim()) : dataUidRaw;
  if (!Number.isInteger(dataUid) || dataUid < 0 || dataUid > 65535) {
    throw containerError('INVALID_APP_CONFIG', 'server.dataUid must be an integer in [0, 65535]');
  }
  const minProtocol = typeof rawServer.minProtocol === 'string' ? rawServer.minProtocol.trim().toUpperCase() : '';
  if (!VALID_PROTOCOLS.includes(minProtocol)) {
    throw containerError('INVALID_APP_CONFIG', `server.minProtocol must be one of ${VALID_PROTOCOLS.join(', ')}`);
  }
  let iconModel = typeof rawServer.iconModel === 'string' ? rawServer.iconModel.trim() : '';
  if (!iconModel) iconModel = ICON_MODEL_DEFAULT;
  // Accept anything non-empty; tiny-samba treats "-" as a literal escape hatch and any other
  // non-empty string as a Samba "fruit:model" value.
  const server = { workgroup, netbiosName, dataUid, minProtocol, iconModel };

  // ── users ─────────────────────────────────────────────────────────
  const oldUsersByName = {};
  if (oldConfig && Array.isArray(oldConfig.users)) {
    for (const u of oldConfig.users) {
      if (u?.name) oldUsersByName[u.name] = u;
    }
  }
  const rawUsers = Array.isArray(newConfig.users) ? newConfig.users : [];
  const users = [];
  const seenUserNames = new Set();
  for (let i = 0; i < rawUsers.length; i++) {
    const u = rawUsers[i];
    if (!u || typeof u !== 'object' || Array.isArray(u)) {
      throw containerError('INVALID_APP_CONFIG', `users[${i}] must be an object`);
    }
    const name = typeof u.name === 'string' ? u.name.trim() : '';
    if (!USER_NAME_REGEX.test(name)) {
      throw containerError(
        'INVALID_APP_CONFIG',
        `users[${i}].name "${name}" is invalid (must start with a lowercase letter; lowercase letters, digits, . _ - only)`,
      );
    }
    if (seenUserNames.has(name)) {
      throw containerError('INVALID_APP_CONFIG', `Duplicate user "${name}"`);
    }
    seenUserNames.add(name);

    // Password handling:
    //   - Non-empty string → set/replace (validate as plaintext or NT hash)
    //   - Omitted, null, '', or {isSet} echo → keep prior password from oldConfig
    let password;
    const incoming = u.password;
    const isUnchangedSentinel =
      incoming === undefined
      || incoming === null
      || incoming === ''
      || (typeof incoming === 'object' && incoming !== null && 'isSet' in incoming);
    if (isUnchangedSentinel) {
      const prior = oldUsersByName[name];
      if (!prior?.password) {
        throw containerError('INVALID_APP_CONFIG', `users[${i}] "${name}" needs a password`);
      }
      password = prior.password;
    } else if (typeof incoming === 'string') {
      // NT hash if it matches the format; otherwise treat as plaintext.
      if (incoming.startsWith('$NT$') && !NT_HASH_REGEX.test(incoming)) {
        throw containerError(
          'INVALID_APP_CONFIG',
          `users[${i}] "${name}" password starts with "$NT$" but is not a valid NT hash (32 hex chars)`,
        );
      }
      password = incoming;
    } else {
      throw containerError('INVALID_APP_CONFIG', `users[${i}] "${name}" password must be a string`);
    }
    users.push({ name, password });
  }

  // ── shares ────────────────────────────────────────────────────────
  const declaredUserNames = new Set(users.map((u) => u.name));
  const rawShares = Array.isArray(newConfig.shares) ? newConfig.shares : [];
  const shares = [];
  const seenShareNames = new Set();
  for (let i = 0; i < rawShares.length; i++) {
    const s = rawShares[i];
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      throw containerError('INVALID_APP_CONFIG', `shares[${i}] must be an object`);
    }
    const name = typeof s.name === 'string' ? s.name.trim().toLowerCase() : '';
    if (!SHARE_NAME_REGEX.test(name)) {
      throw containerError(
        'INVALID_APP_CONFIG',
        `shares[${i}].name "${name}" must be a lowercase DNS label (a-z, 0-9, hyphen)`,
      );
    }
    if (seenShareNames.has(name)) {
      throw containerError('INVALID_APP_CONFIG', `Duplicate share "${name}"`);
    }
    seenShareNames.add(name);

    // The in-container mount path is fixed by convention (`/shares/<name>`) — no user input.
    // It's an implementation detail of the container, not something the SMB client sees.
    const guest = s.guest === true;

    // Optional host source: when set, the share is backed by a wisp storage mount instead of the
    // container's local files dir. {sourceId} → settings.mounts entry; {subPath} → relative dir
    // inside that mount root.
    let source = null;
    if (s.source && typeof s.source === 'object' && !Array.isArray(s.source)) {
      const sourceId = typeof s.source.sourceId === 'string' ? s.source.sourceId.trim() : '';
      if (sourceId) {
        const subPathRaw = typeof s.source.subPath === 'string' ? s.source.subPath.trim() : '';
        if (subPathRaw.startsWith('/')) {
          throw containerError('INVALID_APP_CONFIG', `shares[${i}].source.subPath must be relative (no leading /)`);
        }
        const segments = subPathRaw.split('/').filter((seg) => seg.length > 0);
        for (const seg of segments) {
          if (seg === '..' || seg === '.') {
            throw containerError('INVALID_APP_CONFIG', `shares[${i}].source.subPath must not contain "." or ".." segments`);
          }
        }
        source = { sourceId, subPath: segments.join('/') };
      }
    }

    let access = [];
    if (!guest) {
      const rawAccess = Array.isArray(s.access) ? s.access : [];
      const seenAccessUsers = new Set();
      for (let j = 0; j < rawAccess.length; j++) {
        const a = rawAccess[j];
        if (!a || typeof a !== 'object' || Array.isArray(a)) {
          throw containerError('INVALID_APP_CONFIG', `shares[${i}].access[${j}] must be an object`);
        }
        const user = typeof a.user === 'string' ? a.user.trim() : '';
        if (!declaredUserNames.has(user)) {
          throw containerError(
            'INVALID_APP_CONFIG',
            `shares[${i}].access[${j}].user "${user}" is not a declared user`,
          );
        }
        if (seenAccessUsers.has(user)) {
          throw containerError('INVALID_APP_CONFIG', `shares[${i}].access lists "${user}" twice`);
        }
        seenAccessUsers.add(user);
        const level = a.level;
        if (level !== 'rw' && level !== 'ro') {
          throw containerError('INVALID_APP_CONFIG', `shares[${i}].access[${j}].level must be "rw" or "ro"`);
        }
        access.push({ user, level });
      }
      // tiny-samba rejects non-guest shares with no access list (rightly — nobody could connect).
      // Catch this here so the UI surfaces a clear error instead of the reload failing.
      if (access.length === 0) {
        throw containerError(
          'INVALID_APP_CONFIG',
          `share "${name}" must grant at least one user (or set guest = true)`,
        );
      }
    }
    // For guest shares, drop any access entries the UI may have sent — the YAML emitter
    // ignores them anyway and persisting them would just be misleading.

    shares.push({ name, guest, source, access });
  }

  return { server, users, shares };
}

/** Convention: every share lives at `/shares/<name>` inside the container. */
function shareContainerPath(share) {
  return `/shares/${share.name}`;
}

/** Quote a string as a YAML double-quoted scalar (handles embedded \ and "). */
function yq(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function renderConfigYaml(appConfig) {
  const lines = [];
  lines.push('# Generated by Wisp from appConfig — do not edit by hand.');
  lines.push('server:');
  lines.push(`  workgroup: ${yq(appConfig.server.workgroup)}`);
  lines.push(`  netbios_name: ${yq(appConfig.server.netbiosName)}`);
  lines.push(`  data_uid: ${appConfig.server.dataUid}`);
  lines.push(`  min_protocol: ${appConfig.server.minProtocol}`);
  lines.push(`  icon_model: ${yq(appConfig.server.iconModel)}`);

  if (appConfig.users.length > 0) {
    lines.push('');
    lines.push('users:');
    for (const u of appConfig.users) {
      lines.push(`  - ${yq(u.name)}`);
    }
  }

  if (appConfig.shares.length > 0) {
    lines.push('');
    lines.push('shares:');
    for (const s of appConfig.shares) {
      lines.push(`  ${yq(s.name)}:`);
      lines.push(`    path: ${yq(shareContainerPath(s))}`);
      if (s.guest) {
        lines.push('    guest: true');
      } else if (s.access.length > 0) {
        lines.push('    access:');
        for (const a of s.access) {
          lines.push(`      ${yq(a.user)}: ${a.level}`);
        }
      }
    }
  }

  return lines.join('\n') + '\n';
}

function renderPasswordsYaml(appConfig) {
  const lines = [];
  lines.push('# Generated by Wisp from appConfig — do not edit by hand.');
  for (const u of appConfig.users) {
    lines.push(`${yq(u.name)}: ${yq(u.password)}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Derived mounts + file contents from appConfig. Each share becomes its own bind-mount
 * (optionally backed by a wisp storage mount); samba-state is a tmpfs.
 */
function generateDerivedConfig(appConfig) {
  const mounts = [
    { type: 'file', name: 'tiny-samba-config', containerPath: '/etc/tiny-samba/config.yaml', readonly: true },
    { type: 'file', name: 'tiny-samba-passwords', containerPath: '/etc/tiny-samba/passwords.yaml', readonly: true },
    { type: 'tmpfs', name: 'tiny-samba-state', containerPath: '/var/lib/samba', sizeMiB: TMPFS_STATE_SIZE_MIB },
  ];

  for (const share of appConfig.shares) {
    const m = {
      type: 'directory',
      name: `share-${share.name}`,
      containerPath: shareContainerPath(share),
      readonly: false,
      // smbd writes data files inside the container as UID dataUid (default 1000); the size:1 idmap
      // (only active when runAsRoot is on, which it is for tiny-samba) maps that to host deployUid
      // so files land cleanly owned by the deploy user.
      containerOwnerUid: appConfig.server.dataUid,
      containerOwnerGid: appConfig.server.dataUid,
    };
    if (share.source) {
      m.sourceId = share.source.sourceId;
      m.subPath = share.source.subPath;
    }
    mounts.push(m);
  }

  return {
    env: {},
    mounts,
    mountContents: {
      'tiny-samba-config': renderConfigYaml(appConfig),
      'tiny-samba-passwords': renderPasswordsYaml(appConfig),
    },
  };
}

function maskSecrets(appConfig) {
  if (!appConfig) return appConfig;
  return {
    ...appConfig,
    users: (appConfig.users || []).map((u) => ({
      name: u.name,
      password: { isSet: !!u.password },
    })),
  };
}

function getReloadCommand() {
  return ['tiny-samba', 'reload'];
}

/**
 * Server-level fields require a smbd restart; tiny-samba's reload command applies
 * everything else live (users, passwords, shares, access).
 */
function requiresRestartForChange(oldConfig, newConfig) {
  if (!oldConfig || !newConfig) return false;
  const o = oldConfig.server || {};
  const n = newConfig.server || {};
  return (
    o.workgroup !== n.workgroup
    || o.netbiosName !== n.netbiosName
    || o.dataUid !== n.dataUid
  );
}

export const tinySambaAppModule = {
  getDefaultAppConfig,
  validateAppConfig,
  generateDerivedConfig,
  maskSecrets,
  getReloadCommand,
  requiresRestartForChange,
};
