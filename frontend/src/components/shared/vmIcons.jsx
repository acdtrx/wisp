import {
  Monitor, Server, Home, Film, HardDrive, Shield, Globe,
  Database, Cloud, Gamepad2, Box, Cpu, Router, Container,
} from 'lucide-react';

// ─── Custom SVG Brand Icons ─────────────────────

export function WindowsIcon({ size = 16, className }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M3 5.5l7.5-1V11H3V5.5zm0 7h7.5v6.5L3 18V12.5zm8.5-8.2L21 3v8.5h-9.5V4.3zm0 8.7H21V21l-9.5-1.3V13z" />
    </svg>
  );
}

export function LinuxIcon({ size = 16, className }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12.5 2c-1.6 0-2.9 1.8-3.2 4.2-.5.2-1 .5-1.4.9C6.2 8.5 5.5 10.5 5.5 12c0 1.2.3 2.2.7 3-.8.5-1.7 1.3-2.2 2.3-.7 1.3-.5 2.7.5 3.3.6.4 1.4.4 2.1.1.7-.3 1.2-.8 1.6-1.4.6.3 1.2.5 1.9.6.1.6.3 1.2.6 1.7.5.7 1.2 1.1 2 1.1s1.5-.4 2-1.1c.3-.5.5-1.1.6-1.7.7-.1 1.3-.3 1.9-.6.4.6.9 1.1 1.6 1.4.7.3 1.5.3 2.1-.1 1-.6 1.2-2 .5-3.3-.5-1-1.4-1.8-2.2-2.3.4-.8.7-1.8.7-3 0-1.5-.7-3.5-2.4-4.9-.4-.4-.9-.7-1.4-.9C15.4 3.8 14.1 2 12.5 2z" />
    </svg>
  );
}

function UbuntuIcon({ size = 16, className }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 2c4.42 0 8 3.58 8 8s-3.58 8-8 8-8-3.58-8-8 3.58-8 8-8zm-4 8a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm6.5-4a1.5 1.5 0 1 1 1.3-2.25 1.5 1.5 0 0 1-1.3 2.25zm0 8a1.5 1.5 0 1 1 1.3.75 1.5 1.5 0 0 1-1.3-.75zM8 12c0-1.2.52-2.27 1.35-3l-.85-1.46A5.98 5.98 0 0 0 6 12c0 1.74.74 3.3 1.93 4.39l.78-1.5A3.98 3.98 0 0 1 8 12zm5.72 3.44l.78 1.5A5.98 5.98 0 0 0 18 12a5.98 5.98 0 0 0-2.5-4.87l-.78 1.5A3.98 3.98 0 0 1 16 12c0 1.4-.72 2.64-1.82 3.35l-.46.09zm-2.22.5A3.9 3.9 0 0 1 10.06 15l-.78 1.5c.8.33 1.68.5 2.6.5h.34l-.07-1.72-.65.66z" />
    </svg>
  );
}

function DebianIcon({ size = 16, className }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M13.88 12.68c.48-.6.82-1.3.92-1.62.14-.4.22-.84.22-1.3 0-.62-.1-1.04-.22-1.44.4.56.64 1.28.64 2.12 0 .92-.32 1.72-.84 2.38-.3-.02-.52-.06-.72-.14zm1.14-4.38c-.34-.62-.86-1.08-1.28-1.28.54.1 1.12.44 1.56.92.68.72 1.04 1.72 1.04 2.66 0 .56-.1 1.1-.34 1.6-.14-.44-.2-.78-.2-1.38 0-.78-.16-1.68-.78-2.52zM12.52 3c.28.04.5.12.5.12s-.2-.06-.5-.12zm.5.12c1.12.24 2.24.96 2.86 1.94-.18-.12-.56-.26-.86-.34.44.6.72 1.14.92 1.96.2.78.14 1.54.06 2.2-.04.14-.08.38-.14.58-.18.62-.52 1.24-.88 1.68-.4.48-.68.64-1.06.88-.34.2-.58.24-.88.28l-.46.06c-.22-.02-.36-.06-.52-.14-.26-.12-.4-.28-.52-.46s-.14-.42-.08-.72c-.12.1-.28.24-.36.54-.1.32-.02.62.08.78-.2.02-.5-.04-.7-.18-.2-.16-.36-.4-.4-.7-.02.14-.02.28 0 .44.04.26.14.44.14.44-.16-.08-.36-.26-.48-.52-.1-.22-.14-.52-.1-.78l.06-.34c.08-.24.22-.46.4-.6-.06 0-.14.02-.24.12-.14.14-.22.32-.28.56-.12-.4-.04-.74.06-.98.12-.28.32-.44.32-.44-.1 0-.22.08-.34.22-.1.12-.18.28-.26.52-.06-.54.04-.94.18-1.22.14-.3.32-.46.32-.46-.14.04-.3.18-.44.38l-.14.24c0-.44.12-.84.32-1.16.2-.3.4-.44.4-.44-.16.04-.34.14-.52.34-.1.12-.2.28-.3.48.04-.56.22-1.04.48-1.38.28-.38.54-.5.54-.5-.22.02-.48.14-.74.38-.14.14-.28.3-.4.5.16-.62.42-1.12.78-1.46-.38.14-.74.54-1 .96.12-.36.28-.66.52-.96.24-.3.48-.48.48-.48-.42.12-.84.48-1.12.88-.3.42-.46.84-.54 1.06-.06.08-.12.28-.2.56-.06.24-.1.52-.12.84-.08.18-.16.46-.22.82-.06.36-.08.76-.04 1.22.02.2.06.4.12.62-.08.2-.14.44-.18.72-.06.48-.02.98.12 1.5-.08.12-.2.4-.3.74-.12.42-.18.92-.12 1.48.02.28.08.54.16.78C7 17.78 9.22 20 12 20c3.14 0 5.68-2.84 5.68-5.68 0-4.14-3.28-7-5.48-7.58-.38-.12-.74-.16-1.04-.2-.34-.04-.62-.04-.62-.04s.2-.04.48-.08zM12 22C6.48 22 2 17.52 2 12S6.48 2 12 2s10 4.48 10 10-4.48 10-10 10z" />
    </svg>
  );
}

function ArchIcon({ size = 16, className }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 2C10.88 5.75 10.26 7.82 9 10.5c.83.63 1.7 1.2 3 1.72 1.32-.52 2.17-1.1 3-1.72C13.74 7.82 13.12 5.75 12 2zM8.18 12.16C6.64 14.94 4.28 18.62 2 22c2.42-1.12 4.24-1.76 6.16-2.06-.94-1.58-1.62-2.94-2.22-4.38.74.48 1.6.96 2.68 1.46l.4-.66c-1-.5-1.78-.96-2.84-2.2zm7.64 0c-1.06 1.24-1.84 1.7-2.84 2.2l.4.66c1.08-.5 1.94-.98 2.68-1.46-.6 1.44-1.28 2.8-2.22 4.38 1.92.3 3.74.94 6.16 2.06-2.28-3.38-4.64-7.06-6.18-9.84z" />
    </svg>
  );
}

function FedoraIcon({ size = 16, className }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 2c4.42 0 8 3.58 8 8s-3.58 8-8 8-8-3.58-8-8 3.58-8 8-8zm-.5 3C9.02 7 7 9.02 7 11.5V16h4.5c2.48 0 4.5-2.02 4.5-4.5S14.48 7 11.5 7zm0 2c1.38 0 2.5 1.12 2.5 2.5S12.88 14 11.5 14H11v-2.5c0-.28.22-.5.5-.5s.5.22.5.5V12h2v-.5C14 9.57 12.93 8.5 11.5 8.5S9 9.57 9 11v3H7v-2.5C7 9.02 9.02 7 11.5 7z" />
    </svg>
  );
}

function FreeBSDIcon({ size = 16, className }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 4.5c.56 0 1 .22 1.32.56-.14.28-.2.6-.2.94 0 .64.28 1.22.72 1.62-.34.24-.74.38-1.18.38-1.1 0-2-.9-2-2s.9-2 1.34-1.5zm5 0c.44-.5 1.34.4 1.34 1.5s-.9 2-2 2c-.44 0-.84-.14-1.18-.38.44-.4.72-.98.72-1.62 0-.34-.06-.66-.2-.94.32-.34.76-.56 1.32-.56zM12 10c2.76 0 5 2.24 5 5 0 1.88-1.04 3.52-2.58 4.37C13.6 18.54 12.84 18 12 18s-1.6.54-2.42 1.37C8.04 18.52 7 16.88 7 15c0-2.76 2.24-5 5-5z" />
    </svg>
  );
}

function HomeAssistantIcon({ size = 16, className }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 1.5L2 9.5V22h7.5v-6.5h5V22H22V9.5L12 1.5zm0 3.19L19 10.5V20h-3.5v-6.5h-7V20H5V10.5l7-5.81zM12 11a2 2 0 1 0 0 4 2 2 0 0 0 0-4z" />
    </svg>
  );
}

function JellyfinIcon({ size = 16, className }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 2C8.27 2 5.14 5.8 4.05 10.94c-.3 1.38-.45 2.86-.45 4.36 0 1.3.12 2.38.35 3.22C4.74 21.42 7.42 22 12 22s7.26-.58 8.05-3.48c.23-.84.35-1.92.35-3.22 0-1.5-.15-2.98-.45-4.36C18.86 5.8 15.73 2 12 2zm0 2.5c2.63 0 4.9 2.85 5.75 6.9.26 1.2.4 2.52.4 3.9 0 1-.08 1.84-.24 2.48-.3 1.08-1.48 1.72-5.91 1.72s-5.61-.64-5.91-1.72c-.16-.64-.24-1.48-.24-2.48 0-1.38.14-2.7.4-3.9C7.1 7.35 9.37 4.5 12 4.5z" />
    </svg>
  );
}

function TrueNASIcon({ size = 16, className }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M4 4h16v3H4V4zm0 5h16v3H4V9zm0 5h16v3H4v-3zm0 5h16v1H4v-1zM6 5.5a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5zm0 5a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5zm0 5a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5zM18 5.25h-8v.5h8v-.5zm0 1h-8v.5h8v-.5zm0 4h-8v.5h8v-.5zm0 1h-8v.5h8v-.5zm0 4h-8v.5h8v-.5zm0 1h-8v.5h8v-.5z" />
    </svg>
  );
}

function DockerIcon({ size = 16, className }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M13.98 11.08h2.12V8.96h-2.12v2.12zm-2.54 0h2.12V8.96H11.44v2.12zm-2.54 0h2.12V8.96H8.9v2.12zm-2.54 0h2.12V8.96H6.36v2.12zm2.54-2.54h2.12V6.42H8.9v2.12zm2.54 0h2.12V6.42H11.44v2.12zm2.54 0h2.12V6.42h-2.12v2.12zm0-2.54h2.12V3.88h-2.12V6zm2.54 5.08c.42 0 1.08-.06 1.56-.3.24-.12.54-.36.72-.72-.54-.36-.84-.9-.96-1.38-.12-.54-.06-1.02-.06-1.02s-.06 0-.18.06c-.54.3-1.62.36-1.62.36H4.04s-.18.96.06 1.98c.3 1.2.84 2.16 1.62 2.88 1.02.96 2.46 1.44 3.48 1.62 1.26.24 3.06.18 4.68-.42 1.26-.48 2.52-1.32 3.36-2.7-.42-.06-.96-.18-1.26-.36z" />
    </svg>
  );
}

function PlexIcon({ size = 16, className }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 2L4 7v10l8 5 8-5V7l-8-5zm0 2.36L18 8.5v7L12 19.64 6 15.5v-7L12 4.36z" />
      <path d="M12 7l-4 2.5v5L12 17l4-2.5v-5L12 7z" />
    </svg>
  );
}

function NixOSIcon({ size = 16, className }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M7.16 5L3 12l1.83 3.08L8.07 9.4h5.45L12.2 7.16H8.63L7.16 5zm2.67 4.58L5.66 17h3.67l1.47-2.5h5.45l1.32-2.24H11.1l-1.27-2.68zm6.03-3.58L12.8 12l1.83 3.08 3.24-5.66-1.32-2.24-1.42 2.42-2.72-4.68L14.17 7l1.69-1.01zm-7.72 7.84L12.3 20h-3.67l.01-2.92h-5.5l-1.3-2.24H8.3l1.84.01zm7.72 4.16l4.14-7-1.83-3.08-3.24 5.68h-2.63l-1.32 2.24h6.46L16.06 18zm2.67-4.58l4.17-6h-3.66l-1.48 2.5H12.1l-1.32 2.24h6.46l1.29 2.68z" />
    </svg>
  );
}

function ProxmoxIcon({ size = 16, className }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 2L3 7v10l9 5 9-5V7l-9-5zm0 2.18L19 9v6l-7 3.88L5 15V9l7-4.82zM10 9v6h1.5v-2.25L13.75 15H15.5l-2.5-2.75L15.25 9H13.5l-2 2.5V9H10z" />
    </svg>
  );
}

// ─── Icon Registry ──────────────────────────────

export const VM_ICONS = [
  // Operating Systems
  { id: 'windows',    name: 'Windows',        category: 'OS', component: WindowsIcon },
  { id: 'linux',      name: 'Linux',          category: 'OS', component: LinuxIcon },
  { id: 'ubuntu',     name: 'Ubuntu',         category: 'OS', component: UbuntuIcon },
  { id: 'debian',     name: 'Debian',         category: 'OS', component: DebianIcon },
  { id: 'arch',       name: 'Arch Linux',     category: 'OS', component: ArchIcon },
  { id: 'fedora',     name: 'Fedora',         category: 'OS', component: FedoraIcon },
  { id: 'nixos',      name: 'NixOS',          category: 'OS', component: NixOSIcon },
  { id: 'freebsd',    name: 'FreeBSD',        category: 'OS', component: FreeBSDIcon },

  // Services
  { id: 'homeassistant', name: 'Home Assistant', category: 'Service', component: HomeAssistantIcon },
  { id: 'jellyfin',     name: 'Jellyfin',       category: 'Service', component: JellyfinIcon },
  { id: 'plex',         name: 'Plex',           category: 'Service', component: PlexIcon },
  { id: 'truenas',      name: 'TrueNAS',        category: 'Service', component: TrueNASIcon },
  { id: 'docker',       name: 'Docker',         category: 'Service', component: DockerIcon },
  { id: 'proxmox',      name: 'Proxmox',        category: 'Service', component: ProxmoxIcon },

  // Generic (lucide-react)
  { id: 'server',    name: 'Server',     category: 'Generic', component: Server },
  { id: 'monitor',   name: 'Desktop',    category: 'Generic', component: Monitor },
  { id: 'database',  name: 'Database',   category: 'Generic', component: Database },
  { id: 'globe',     name: 'Web',        category: 'Generic', component: Globe },
  { id: 'cloud',     name: 'Cloud',      category: 'Generic', component: Cloud },
  { id: 'shield',    name: 'Firewall',   category: 'Generic', component: Shield },
  { id: 'router',    name: 'Router',     category: 'Generic', component: Router },
  { id: 'harddrive', name: 'Storage',   category: 'Generic', component: HardDrive },
  { id: 'film',      name: 'Media',      category: 'Generic', component: Film },
  { id: 'gamepad',   name: 'Gaming',     category: 'Generic', component: Gamepad2 },
  { id: 'cpu',       name: 'Compute',    category: 'Generic', component: Cpu },
  { id: 'container', name: 'Container',  category: 'Generic', component: Container },
  { id: 'home',      name: 'Home',       category: 'Generic', component: Home },
  { id: 'box',       name: 'Other',      category: 'Generic', component: Box },
];

const ICON_MAP = Object.fromEntries(VM_ICONS.map(i => [i.id, i]));

export function getVmIcon(iconId) {
  return ICON_MAP[iconId] || ICON_MAP['monitor'];
}

export function getDefaultIconId(osCategory) {
  if (osCategory === 'windows') return 'windows';
  if (osCategory === 'linux') return 'linux';
  return 'monitor';
}

/** Default workload icon for containers (matches list/overview Box-style default). */
export function getDefaultContainerIconId() {
  return 'box';
}
