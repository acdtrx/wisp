/**
 * Frontend app registry — maps app IDs to their groups on the container page and their
 * metadata.
 */
import CaddyGroups from './caddy/CaddyGroups.jsx';
import ZotGroups from './zot/ZotGroups.jsx';
import TinySambaGroups from './tinySamba/TinySambaGroups.jsx';
import JellyfinGroups from './jellyfin/JellyfinGroups.jsx';

const APP_REGISTRY = {
  'caddy-reverse-proxy': {
    label: 'Caddy Reverse Proxy',
    description: 'HTTPS reverse proxy with Let\'s Encrypt and Cloudflare DNS',
    defaultImage: 'caddy:latest',
    allowCustomImage: true,
    Groups: CaddyGroups,
  },
  'zot-registry': {
    label: 'Zot OCI Registry',
    description: 'Private OCI container image registry',
    defaultImage: 'ghcr.io/project-zot/zot-linux-amd64:latest',
    allowCustomImage: true,
    Groups: ZotGroups,
  },
  'jellyfin': {
    label: 'Jellyfin',
    description: 'Self-hosted media server with optional GPU-accelerated transcoding',
    defaultImage: 'jellyfin/jellyfin:latest',
    allowCustomImage: true,
    Groups: JellyfinGroups,
  },
  'tiny-samba': {
    label: 'Tiny Samba',
    description: 'Lightweight SMB file server with declarative shares + users',
    defaultImage: 'ghcr.io/acdtrx/tiny-samba:latest',
    allowCustomImage: true,
    Groups: TinySambaGroups,
  },
};

export function getAppEntry(appId) {
  return Object.hasOwn(APP_REGISTRY, appId ?? '') ? APP_REGISTRY[appId] : null;
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
