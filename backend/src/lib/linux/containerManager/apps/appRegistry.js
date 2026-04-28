/**
 * App registry — maps app IDs to their backend modules.
 * Each module exports: getDefaultAppConfig, validateAppConfig, generateDerivedConfig, maskSecrets,
 * getReloadCommand, and optionally requiresRestartForChange.
 *
 * Registry-level flags:
 *   - `requiresRoot: true` flips on container.runAsRoot at create time. Use for apps that need
 *     UID 0 inside the container (e.g. smbd binding 445 + setuid per session).
 */
import { caddyAppModule } from './caddy.js';
import { zotAppModule } from './zot.js';
import { tinySambaAppModule } from './tinySamba.js';

export const APP_REGISTRY = {
  'caddy-reverse-proxy': {
    label: 'Caddy Reverse Proxy',
    description: 'HTTPS reverse proxy with Let\'s Encrypt and Cloudflare DNS',
    defaultImage: 'caddy:latest',
    allowCustomImage: true,
    module: caddyAppModule,
  },
  'zot-registry': {
    label: 'Zot OCI Registry',
    description: 'Private OCI container image registry',
    defaultImage: 'ghcr.io/project-zot/zot-linux-amd64:latest',
    allowCustomImage: true,
    module: zotAppModule,
  },
  'tiny-samba': {
    label: 'Tiny Samba',
    description: 'Lightweight SMB file server with declarative shares + users',
    defaultImage: 'ghcr.io/acdtrx/tiny-samba:latest',
    allowCustomImage: true,
    requiresRoot: true,
    // Seed mDNS service entries at create so `<container>.local` is discoverable as an SMB
    // host out of the box. Users can edit/remove them later via the Services section.
    defaultServices: [
      { port: 445, type: '_smb._tcp', txt: {} },
    ],
    module: tinySambaAppModule,
  },
};

export function getAppModule(appId) {
  return APP_REGISTRY[appId]?.module || null;
}

export function getAppEntry(appId) {
  return APP_REGISTRY[appId] || null;
}

export function isKnownApp(appId) {
  return appId in APP_REGISTRY;
}
