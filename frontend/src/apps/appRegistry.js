/**
 * Frontend app registry — maps app IDs to their UI components and metadata.
 */
import CaddyAppSection from './caddy/CaddyAppSection.jsx';
import ZotAppSection from './zot/ZotAppSection.jsx';
import TinySambaAppSection from './tinySamba/TinySambaAppSection.jsx';
import JellyfinAppSection from './jellyfin/JellyfinAppSection.jsx';

export const APP_REGISTRY = {
  'caddy-reverse-proxy': {
    label: 'Caddy Reverse Proxy',
    description: 'HTTPS reverse proxy with Let\'s Encrypt and Cloudflare DNS',
    defaultImage: 'caddy:latest',
    allowCustomImage: true,
    component: CaddyAppSection,
  },
  'zot-registry': {
    label: 'Zot OCI Registry',
    description: 'Private OCI container image registry',
    defaultImage: 'ghcr.io/project-zot/zot-linux-amd64:latest',
    allowCustomImage: true,
    component: ZotAppSection,
  },
  'jellyfin': {
    label: 'Jellyfin',
    description: 'Self-hosted media server with optional GPU-accelerated transcoding',
    defaultImage: 'jellyfin/jellyfin:latest',
    allowCustomImage: true,
    component: JellyfinAppSection,
  },
  'tiny-samba': {
    label: 'Tiny Samba',
    description: 'Lightweight SMB file server with declarative shares + users',
    defaultImage: 'ghcr.io/acdtrx/tiny-samba:latest',
    allowCustomImage: true,
    component: TinySambaAppSection,
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
