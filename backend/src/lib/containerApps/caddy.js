/**
 * Caddy Reverse Proxy app module (docs/specs/CUSTOM-APPS.md, App: Caddy).
 * Its sites are `<subdomain>.<domain>` under the host's certificate, which Wisp
 * gets and renews (docs/specs/CERTIFICATES.md): Caddy only loads the two
 * `tls-` files, so the stock image serves them, and the app holds no domain,
 * token or certificate of its own.
 */
import { createAppError as containerError } from '../appErrors.js';

const TLS_CERT_PATH = '/etc/caddy/tls/fullchain.pem';
const TLS_KEY_PATH = '/etc/caddy/tls/key.pem';

/** Default appConfig for a new Caddy container: no sites. */
function getDefaultAppConfig() {
  return { hosts: [] };
}

/** Validate and normalize appConfig (`{ hosts }` only). Throws INVALID_APP_CONFIG. */
function validateAppConfig(appConfig) {
  if (!appConfig || typeof appConfig !== 'object' || Array.isArray(appConfig)) {
    throw containerError('INVALID_APP_CONFIG', 'appConfig must be an object');
  }
  const unknown = Object.keys(appConfig).filter((k) => k !== 'hosts');
  if (unknown.length) {
    throw containerError(
      'INVALID_APP_CONFIG',
      `The Caddy app's config holds only hosts, not ${unknown.join(', ')}`,
      'The domain and its certificate are the host\'s: Host → App Config → Certificate',
    );
  }
  const { hosts } = appConfig;
  if (!Array.isArray(hosts)) {
    throw containerError('INVALID_APP_CONFIG', 'hosts must be an array');
  }
  const seen = new Set();
  const normalizedHosts = hosts.map((h, i) => {
    if (!h || typeof h !== 'object') {
      throw containerError('INVALID_APP_CONFIG', `hosts[${i}] must be an object`);
    }
    const sub = typeof h.subdomain === 'string' ? h.subdomain.trim().toLowerCase() : '';
    if (!sub) {
      throw containerError('INVALID_APP_CONFIG', `hosts[${i}].subdomain is required`);
    }
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(sub)) {
      throw containerError('INVALID_APP_CONFIG', `hosts[${i}].subdomain "${sub}" is not a valid DNS label`);
    }
    if (seen.has(sub)) {
      throw containerError('INVALID_APP_CONFIG', `Duplicate subdomain "${sub}"`);
    }
    seen.add(sub);

    const target = typeof h.target === 'string' ? h.target.trim() : '';
    if (!target) {
      throw containerError('INVALID_APP_CONFIG', `hosts[${i}].target is required`);
    }
    // The target is interpolated raw into the Caddyfile (`reverse_proxy ${target}`):
    // a `\n`, `{` or `}` would inject directives. Allow the common shapes (host,
    // host:port, scheme://host[:port][/path]) and nothing with structural meaning.
    if (/[\n\r{}]/.test(target)) {
      throw containerError('INVALID_APP_CONFIG', `hosts[${i}].target contains invalid characters`);
    }
    if (!/^([a-z][a-z0-9+.-]*:\/\/)?[a-zA-Z0-9._-]+(:[0-9]{1,5})?(\/[^\s\n\r{}]*)?$/.test(target)) {
      throw containerError(
        'INVALID_APP_CONFIG',
        `hosts[${i}].target must be host[:port] or scheme://host[:port][/path]`,
      );
    }

    return { subdomain: sub, target };
  });

  return { hosts: normalizedHosts };
}

/**
 * The Caddyfile: with the host's certificate, one wildcard site under its
 * domain that loads the two `tls-` files, a handler per host and a 404 for any
 * other name; without one, no site.
 */
function generateCaddyfile(appConfig, certificate) {
  const lines = [];
  // Global options. The reverse proxy's own logs go to a logger capped at ERROR:
  // it logs every disconnecting SSE client as a WARN, which floods the log on
  // SSE-heavy sites like Wisp, while real upstream failures still show.
  lines.push('{');
  lines.push('  log default {');
  lines.push('    exclude http.handlers.reverse_proxy');
  lines.push('  }');
  lines.push('  log reverse_proxy {');
  lines.push('    include http.handlers.reverse_proxy');
  lines.push('    level ERROR');
  lines.push('  }');
  lines.push('}');
  lines.push('');

  if (!certificate) {
    lines.push('# Wisp holds no certificate yet: set it up in Host → App Config → Certificate.');
    return lines.join('\n') + '\n';
  }

  const { domain } = certificate;
  lines.push(`*.${domain} {`);
  lines.push(`  tls ${TLS_CERT_PATH} ${TLS_KEY_PATH}`);
  lines.push('');
  for (const host of appConfig.hosts) {
    lines.push(`  @${host.subdomain} host ${host.subdomain}.${domain}`);
    lines.push(`  handle @${host.subdomain} {`);
    lines.push(`    reverse_proxy ${host.target}`);
    lines.push('  }');
    lines.push('');
  }
  lines.push('  handle {');
  lines.push('    respond "No matching host" 404');
  lines.push('  }');
  lines.push('}');
  return lines.join('\n') + '\n';
}

/**
 * The derived config. The two `tls-` files are always mounted, empty while Wisp
 * holds no certificate, so its arrival changes file contents and never the
 * mount layout: a running Caddy takes it by reload.
 */
function generateDerivedConfig(appConfig, { certificate = null } = {}) {
  const mounts = [
    { type: 'file', name: 'Caddyfile', containerPath: '/etc/caddy/Caddyfile', readonly: true },
    { type: 'file', name: 'tls-cert', containerPath: TLS_CERT_PATH, readonly: true },
    { type: 'file', name: 'tls-key', containerPath: TLS_KEY_PATH, readonly: true },
    { type: 'directory', name: 'caddy-data', containerPath: '/data', readonly: false },
    { type: 'directory', name: 'caddy-config', containerPath: '/config', readonly: false },
  ];
  const mountContents = {
    Caddyfile: generateCaddyfile(appConfig, certificate),
    'tls-cert': certificate?.chain ?? '',
    'tls-key': certificate?.key ?? '',
  };
  return { env: {}, mounts, mountContents };
}

/** The certificate's key is the one secret file. */
function getSecretMountNames() {
  return ['tls-key'];
}

/**
 * Reload without a restart. `--force` makes Caddy load the config, and with it
 * the certificate files, even when the Caddyfile is unchanged: a renewal changes
 * only the files.
 */
function getReloadCommand() {
  return ['caddy', 'reload', '--config', '/etc/caddy/Caddyfile', '--force'];
}

/**
 * URLs this container publishes, for the Home page launcher: one per host under
 * the domain of the certificate Wisp holds, none while it holds none. `target`
 * is carried so the tile joins the workload the host fronts.
 */
function getPublishedLinks(appConfig, { certificate = null } = {}) {
  if (!certificate?.domain) return [];
  const hosts = Array.isArray(appConfig?.hosts) ? appConfig.hosts : [];
  return hosts
    .filter((h) => h && typeof h.subdomain === 'string' && h.subdomain.trim())
    .map((h) => ({
      url: `https://${h.subdomain.trim()}.${certificate.domain}`,
      target: typeof h.target === 'string' ? h.target : undefined,
    }));
}

export const caddyAppModule = {
  getDefaultAppConfig,
  validateAppConfig,
  generateDerivedConfig,
  getSecretMountNames,
  getReloadCommand,
  getPublishedLinks,
  usesHostCertificate: true,
  // The host rows are all the app's config; the domain and its certificate are the
  // host's, out of an agent's reach.
  agentWritableAppConfigFields: ['hosts'],
};
