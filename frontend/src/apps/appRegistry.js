/**
 * Frontend app registry — maps app IDs to their UI components and metadata.
 */
import CaddyAppSection from './caddy/CaddyAppSection.jsx';

export const APP_REGISTRY = {
  'caddy-reverse-proxy': {
    label: 'Caddy Reverse Proxy',
    description: 'HTTPS reverse proxy with Let\'s Encrypt and Cloudflare DNS',
    defaultImage: 'caddy:latest',
    allowCustomImage: true,
    component: CaddyAppSection,
  },
};

export function getAppEntry(appId) {
  return APP_REGISTRY[appId] || null;
}

export function getAppList() {
  return Object.entries(APP_REGISTRY).map(([id, entry]) => ({
    id,
    label: entry.label,
    description: entry.description,
    defaultImage: entry.defaultImage,
    allowCustomImage: entry.allowCustomImage,
  }));
}
