/**
 * Caddy Reverse Proxy app module.
 * Manages Caddyfile generation, Cloudflare DNS env var, and persistent data/config mounts.
 */
import { createAppError as containerError } from '../routeErrors.js';

/**
 * Default appConfig for a new Caddy container.
 */
function getDefaultAppConfig() {
  return {
    domain: '',
    email: '',
    hosts: [],
    cloudflareDnsEnabled: false,
    cloudflareApiToken: '',
  };
}

/**
 * Validate and normalize appConfig. Throws INVALID_APP_CONFIG on failure.
 *
 * `oldAppConfig` carries the stored secret forward: `maskSecrets` replaces the token with
 * `{ isSet }`, and the form omits it entirely when the user didn't retype it, so without
 * the merge below an unrelated save (adding a host) would silently blank the token and
 * break the DNS-01 challenge at the next certificate renewal.
 */
function validateAppConfig(appConfig, oldAppConfig = null) {
  if (!appConfig || typeof appConfig !== 'object' || Array.isArray(appConfig)) {
    throw containerError('INVALID_APP_CONFIG', 'appConfig must be an object');
  }

  const { domain, email, hosts, cloudflareDnsEnabled, cloudflareApiToken } = appConfig;

  // email: optional string for Let's Encrypt registration
  if (email != null && typeof email !== 'string') {
    throw containerError('INVALID_APP_CONFIG', 'email must be a string');
  }
  const trimmedEmail = typeof email === 'string' ? email.trim() : '';

  // domain: required non-empty string, no protocol prefix, no trailing dot
  if (typeof domain !== 'string') {
    throw containerError('INVALID_APP_CONFIG', 'domain must be a string');
  }
  const trimmedDomain = domain.trim();
  if (trimmedDomain && /^https?:\/\//i.test(trimmedDomain)) {
    throw containerError('INVALID_APP_CONFIG', 'domain must not include a protocol (e.g. use "example.com" not "https://example.com")');
  }
  if (trimmedDomain.endsWith('.')) {
    throw containerError('INVALID_APP_CONFIG', 'domain must not end with a trailing dot');
  }

  // hosts: array of { subdomain, target }
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
    // The target is interpolated raw into the Caddyfile (`reverse_proxy ${target}`).
    // Without validation, an admin (or a future automation that surfaces this
    // field) could inject Caddy directives by including `\n`, `{`, or `}`.
    // Allow common shapes (host, host:port, scheme://host[:port][/path]) and
    // reject any character that has structural meaning in a Caddyfile.
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

  // cloudflareApiToken: optional. A non-string (absent, or the `{ isSet }` mask coming
  // back round) means "unchanged" — keep what's on disk. An explicit '' clears it.
  if (cloudflareApiToken != null && typeof cloudflareApiToken !== 'string'
      && !(typeof cloudflareApiToken === 'object' && 'isSet' in cloudflareApiToken)) {
    throw containerError('INVALID_APP_CONFIG', 'cloudflareApiToken must be a string');
  }
  const token = typeof cloudflareApiToken === 'string'
    ? cloudflareApiToken.trim()
    : (oldAppConfig?.cloudflareApiToken || '');

  // cloudflareDnsEnabled: the user's assertion that the image ships the
  // caddy-dns/cloudflare module (a compile-time xcaddy plugin the stock caddy
  // image lacks — a Caddyfile referencing it makes that image fail to start).
  // Absent means "unchanged"; configs stored before this field existed
  // expressed the same intent by setting the token.
  if (cloudflareDnsEnabled != null && typeof cloudflareDnsEnabled !== 'boolean') {
    throw containerError('INVALID_APP_CONFIG', 'cloudflareDnsEnabled must be a boolean');
  }
  const dnsEnabled = typeof cloudflareDnsEnabled === 'boolean'
    ? cloudflareDnsEnabled
    : typeof oldAppConfig?.cloudflareDnsEnabled === 'boolean'
      ? oldAppConfig.cloudflareDnsEnabled
      : !!token;

  return {
    domain: trimmedDomain,
    email: trimmedEmail,
    hosts: normalizedHosts,
    cloudflareDnsEnabled: dnsEnabled,
    cloudflareApiToken: token,
  };
}

/**
 * Build a Caddyfile string from appConfig.
 */
function generateCaddyfile(appConfig) {
  const { domain, email, hosts, cloudflareDnsEnabled, cloudflareApiToken } = appConfig;
  // Both gates: the token without the module assertion would emit directives
  // the image can't parse; the assertion without a token has nothing to send.
  const dnsActive = !!(cloudflareDnsEnabled && cloudflareApiToken);
  const lines = [];

  // Global options block. Always emitted so SSE-aware log filtering is in place:
  // reverse_proxy logs every SSE client abort as a WARN ("aborting with incomplete response").
  // Route reverse_proxy logs to a separate logger capped at ERROR so real upstream failures
  // still surface while per-disconnect warns don't spam the log on SSE-heavy apps like Wisp.
  lines.push('{');
  if (email) lines.push(`  email ${email}`);
  if (dnsActive) lines.push('  acme_dns cloudflare {env.CLOUDFLARE_API_TOKEN}');
  lines.push('  log default {');
  lines.push('    exclude http.handlers.reverse_proxy');
  lines.push('  }');
  lines.push('  log reverse_proxy {');
  lines.push('    include http.handlers.reverse_proxy');
  lines.push('    level ERROR');
  lines.push('  }');
  lines.push('}');
  lines.push('');

  if (!domain) {
    // No domain configured yet — placeholder Caddyfile
    lines.push('# No domain configured yet. Set a domain in the Caddy app configuration.');
    return lines.join('\n') + '\n';
  }

  // Wildcard site block
  lines.push(`*.${domain} {`);

  if (dnsActive) {
    lines.push('  tls {');
    lines.push('    dns cloudflare {env.CLOUDFLARE_API_TOKEN}');
    lines.push('  }');
    lines.push('');
  }

  for (const host of hosts) {
    const fqdn = `${host.subdomain}.${domain}`;
    lines.push(`  @${host.subdomain} host ${fqdn}`);
    lines.push(`  handle @${host.subdomain} {`);
    lines.push(`    reverse_proxy ${host.target}`);
    lines.push('  }');
    lines.push('');
  }

  // Fallback handler
  lines.push('  handle {');
  lines.push('    respond "No matching host" 404');
  lines.push('  }');
  lines.push('}');

  return lines.join('\n') + '\n';
}

/**
 * Generate derived config (env, mounts, mount file contents) from appConfig.
 */
function generateDerivedConfig(appConfig) {
  const env = {};
  if (appConfig.cloudflareDnsEnabled && appConfig.cloudflareApiToken) {
    env.CLOUDFLARE_API_TOKEN = { value: appConfig.cloudflareApiToken, secret: true };
  }

  const mounts = [
    { type: 'file', name: 'Caddyfile', containerPath: '/etc/caddy/Caddyfile', readonly: true },
    { type: 'directory', name: 'caddy-data', containerPath: '/data', readonly: false },
    { type: 'directory', name: 'caddy-config', containerPath: '/config', readonly: false },
  ];

  const mountContents = {
    Caddyfile: generateCaddyfile(appConfig),
  };

  return { env, mounts, mountContents };
}

/**
 * Return appConfig with secrets redacted for API responses.
 */
function maskSecrets(appConfig) {
  if (!appConfig) return appConfig;
  return {
    ...appConfig,
    cloudflareApiToken: appConfig.cloudflareApiToken
      ? { isSet: true }
      : { isSet: false },
  };
}

/**
 * Command to reload config without restarting the container.
 * Returns null if the app doesn't support live reload.
 */
function getReloadCommand() {
  return ['caddy', 'reload', '--config', '/etc/caddy/Caddyfile'];
}

export const caddyAppModule = {
  getDefaultAppConfig,
  validateAppConfig,
  generateDerivedConfig,
  maskSecrets,
  getReloadCommand,
  // Only the reverse-proxy host rows are agent-writable (MCP update_app_config).
  // domain and email are the certificate identity and cloudflareApiToken is a
  // secret — all three stay human-only so an agent can't break TLS by mistake.
  agentWritableAppConfigFields: ['hosts'],
};
