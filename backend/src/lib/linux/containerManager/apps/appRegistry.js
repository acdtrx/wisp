/**
 * App registry — maps app IDs to their backend modules.
 * Each module exports: getDefaultAppConfig, validateAppConfig, generateDerivedConfig, maskSecrets.
 */
import { caddyAppModule } from './caddy.js';

export const APP_REGISTRY = {
  'caddy-reverse-proxy': {
    label: 'Caddy Reverse Proxy',
    description: 'HTTPS reverse proxy with Let\'s Encrypt and Cloudflare DNS',
    defaultImage: 'caddy:latest',
    allowCustomImage: true,
    module: caddyAppModule,
  },
};

export function getAppModule(appId) {
  return APP_REGISTRY[appId]?.module || null;
}

export function isKnownApp(appId) {
  return appId in APP_REGISTRY;
}
