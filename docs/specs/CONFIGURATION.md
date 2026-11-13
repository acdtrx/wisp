# Configuration

Wisp uses **`config/`** at the project (install) root for persistent data: optional process overrides (`config/runtime.env`), application settings (`config/wisp-config.json`), and the login secret (`config/wisp-password`). The backend loads `config/runtime.env` when present; **port and other settings have built-in defaults** if the file is missing.

## Deployment (install.sh)

On a new server, run `./scripts/install.sh` from the unpacked release (slim zip from `scripts/package.sh`) or from a full git checkout. The script prompts for install directory (default `/opt/wisp`), server name, and initial password; runs `scripts/linux/setup/copy.sh` (replaces `frontend/`, `backend/`, `scripts/`, `systemd/` from the source tree and refreshes `config/*.example`); runs `scripts/setup-server.sh` with sudo; runs `scripts/linux/setup/config.sh` and `scripts/linux/setup/password.sh`; runs `scripts/wispctl.sh build`; and `scripts/linux/setup/permissions.sh`. Optionally installs and starts the systemd unit (`wisp.service`) on first install; if it is already present, prompts to **restart** it instead (default yes), for upgrades without reinstalling. Run as a normal user; sudo is used for install directory creation (when needed) and for `setup-server.sh`.

## Optional `config/runtime.env`

If this file exists, the backend parses `KEY=value` lines (comments and blank lines ignored) **only for keys not already set** in the process environment. Systemd uses `EnvironmentFile=-<install>/config/runtime.env` (leading `-` means the file may be absent).

**Read strictly** (settled 2026-11-12, CODING-RULES §4): startup fails, naming the line or key, on a line that isn't `KEY=value` (an `export` prefix included), a key set twice, a `WISP_*` key not in the table below, or a `WISP_*` value that fails its check. Keys outside `WISP_*` are left alone — systemd shares the file. An empty value means unset. The migration runner applies the same checks before any migration runs, skipping only the lines setting the retired `WISP_BACKEND_PORT` / `WISP_FRONTEND_PORT`, which migration `0007` removes; after the migrations it parses the file strictly again. `wispctl`, `install.sh` and `wisp-updater` check `WISP_PORT` the same way.

| Variable | Default | Description |
|----------|---------|-------------|
| `WISP_PORT` | `8080` | Port the Wisp server listens on (serves both API and SPA). Digits, 1–65535. |
| `WISP_DEFAULT_BRIDGE` | (unset) | Override default bridge for new VM NICs; backend auto-detects if unset. Must name an existing host bridge, checked at startup (Linux). |
| `GITHUB_TOKEN` | (unset) | Optional; some download flows in the backend. |
| `WISP_POWER_SCRIPT` | (unset) | Path to `wisp-power` helper (each `*_SCRIPT` override must be an absolute path to an executable file). If unset, backend uses first existing path: `/usr/local/bin/wisp-power` (after `setup-server.sh`), then bundled `<install>/backend/scripts/wisp-power`. |
| `WISP_DMIDECODE_SCRIPT` | (unset) | Path to RAM info helper. If unset, backend uses first existing path: `/usr/local/bin/wisp-dmidecode` (after `setup-server.sh`), then bundled `<install>/backend/scripts/wisp-dmidecode`. |
| `WISP_SMARTCTL_SCRIPT` | (unset) | Path to `wisp-smartctl` helper for disk SMART. If unset: `/usr/local/bin/wisp-smartctl`, then bundled `backend/scripts/wisp-smartctl`. Same sudoers pattern as `wisp-dmidecode`. |
| `WISP_NETNS_SCRIPT` | (unset) | Path to `wisp-netns` helper (`add`/`delete` + `ip netns`). If unset: `/usr/local/bin/wisp-netns` (installed by install-helpers, which also grants the deploy user `sudo -n`); with no helper, netns add/delete fall back to plain `ip netns` (works only when the backend runs as root). |
| `WISP_CNI_SCRIPT` | (unset) | Path to `wisp-cni` helper (runs a CNI plugin with config file). If unset: `/usr/local/bin/wisp-cni`; with no helper the plugin under `/opt/cni/bin` is executed directly. Same sudoers pattern as `wisp-netns`. |
| `WISP_CONFIG_PATH` | (unset) | Override path for `wisp-config.json`; default `<project>/config/wisp-config.json`. Absolute. |
| `WISP_CONTAINERD_SOCK` | `/run/containerd/containerd.sock` | containerd's gRPC socket. Absolute. |
| `WISP_CNI_BIN_DIR` | `/opt/cni/bin` | CNI plugin directory. Absolute. |
| `WISP_CNI_CONF_DIR` | `/etc/cni/net.d` | CNI network config directory. Absolute. |
| `WISP_ALLOWED_WS_ORIGINS` | (unset) | Comma-separated origins (`scheme://host[:port]`) allowed to open console WebSockets besides the same origin. |
| `WISP_UPDATE_REPO` | `acdtrx/wisp` | GitHub `<owner>/<repo>` that self-update checks for releases. |
| `WISP_ROUTE_ACCESS_REPORT` | (unset) | `1` prints the route access table and exits (`npm run route-access`); `0` or unset boots normally. |
| `NODE_ENV` | (unset) | `development` enables CORS for `localhost:5173`. |

Shipped template: `config/runtime.env.example` (copy to `runtime.env` if you need overrides).

OS updates, SMB shares, and removable-drive mounts use **`/usr/local/bin/wisp-os-update`** and **`/usr/local/bin/wisp-mount`** when installed by `setup-server.sh` (no env vars required).

## Application Config (`config/wisp-config.json`)

JSON file managed by the Settings UI. Default path: `config/wisp-config.json` (or `WISP_CONFIG_PATH`). Created from `config/wisp-config.json.example` on first install.

**Atomic writes.** `wisp-config.json`, every container's `container.json`, and the `oci-image-meta.json` sidecar are written via `writeJsonAtomic`: stage to a `*.tmp.<pid>.<timestamp>.<rand>` sibling, `fsync`, then `rename(2)`. Readers always see either the previous full file or the new full file — never a half-written one. Orphan temp files left by a crash between fsync and rename are swept by `cleanPartialJsonArtifacts` at backend startup.

**Settings concurrency.** `updateSettings`, `addMount`, `updateMount`, and `removeMount` read the on-disk file **inside** the write mutex (`withSettingsWriteLock`) so concurrent `PATCH /api/settings` calls cannot lose updates.

### Schema

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `serverName` | `string \| null` | `null` | Display name in the top bar. Falls back to `My Server` when null. |
| `vmsPath` | `string` | `/var/lib/wisp/vms` | VM storage root (absolute). |
| `imagePath` | `string` | `/var/lib/wisp/images` | Image library path. |
| `backupLocalPath` | `string` | `/var/lib/wisp/backups` | Local backup directory. |
| `containersPath` | `string` | `/var/lib/wisp/containers` | Container storage root (absolute). |
| `mounts` | `array` | `[]` | Configured mounts (see object shape below). Includes SMB shares and adopted removable drives. |
| `backupMountId` | `string \| null` | `null` | Optional `id` of a `mounts` entry to expose as a backup destination in the UI. Must name a mount in `mounts`, else startup fails. |
| `backupSchedule` | `object` | `{ enabled: false, time: "03:00", destinationIds: ["local"], retainDays: 7, retainWeeks: 4 }` | Daily scheduled container backups. `time` is `HH:MM` (24h, host-local); `destinationIds` is a non-empty subset of `'local'` + `backupMountId`; `retainDays` 1–365; `retainWeeks` 0–52. A missing field takes its default; an invalid one — a destination that is neither `'local'` nor `backupMountId` included — fails startup. Deleting the backup mount, or changing `backupMountId`, drops the old mount from `destinationIds` in the same write (`["local"]` when nothing else remains). See [BACKUPS.md → Scheduled backups](BACKUPS.md#scheduled-backups). |
| `sections` | `array` | `[]` | User-defined sidebar sections (see object shape below). The synthetic `Main` section is implicit and never persisted. |
| `assignments` | `object` | `{}` | Map of `"<type>:<workload-name>"` → `sectionId`. Missing entries (or entries pointing at a removed section) fall back to `Main`. `<type>` is `vm` or `container`. |
| `homepage` | `object` | `{ groups: [], overrides: {}, manualTiles: [] }` | Home page overlay (see object shape below). Managed exclusively via `GET/POST/PATCH/PUT/DELETE /api/homepage`, never via `PATCH /api/settings`, and not part of `GET /api/settings` — the client reads it through the derived `home` events topic. |
| `discoveryEnabled` | `boolean` | `true` | Announce this instance as a `_wisp._tcp` mDNS service and browse for peers (see [DISCOVERY.md](DISCOVERY.md)). |
| `advertisedUrl` | `string \| null` | `null` | This instance's browser-facing URL; must be `http`/`https`. Other Wisp instances open it from the mDNS announcement, and its origin pins the OIDC callback URL ([AUTH.md](AUTH.md) § OIDC). `null` → announce `http://<hostname>.local:<port>`; OIDC falls back to the request origin. |
| `updateChannel` | `"stable" \| "beta"` | `"stable"` | Which releases self-update offers this host: `stable` takes GitHub's latest release, `beta` also takes pre-releases. Any other value fails startup. Edited from **Host → Software** (the Wisp Update card), not the Settings page. See [UPDATES.md → Update channels](UPDATES.md#update-channels). |
| `oidc` | `object` | `{ enabled: false, issuer: "", clientId: "", clientSecret: "" }` | Optional OpenID Connect SSO (see [AUTH.md](AUTH.md) § OIDC). `enabled: true` requires `issuer` (valid `http`/`https`), `clientId`, and `clientSecret` — the API refuses to save it otherwise, and startup fails on a file that has it. **`clientSecret` is a secret** — masked in the API as `hasClientSecret` (boolean), never returned. Written only via the session-only `PATCH /api/settings/oidc`. |
| `trustedProxies` | `string[]` | `[]` | Extra reverse-proxy sources whose `X-Forwarded-Proto` / `X-Forwarded-For` Wisp honors (in addition to the always-trusted loopback). See **Reverse proxy / HTTPS** below. Not editable from the UI. |
| `apiTokens` | `array` | `[]` | Bearer API tokens for non-interactive clients: `{ id, label, scope: "read" \| "admin", tokenHash, createdAt }`. **SHA-256 hashes only — the plaintext is never stored.** Managed exclusively via `GET/POST/DELETE /api/auth/tokens` (Host → App Config → API tokens), never via `PATCH /api/settings`, and never returned by `GET /api/settings`. See [AUTH.md](AUTH.md) § API tokens. |

### Section object (`sections[]`)

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | UUID. The constant `"main"` is reserved for the implicit Main bucket and never appears in the persisted array. |
| `name` | `string` | Display name (1–64 chars; case-insensitive uniqueness within `sections`). |
| `order` | `number` | Stable sort order. New sections take `max(order)+1`. |

### Home page object (`homepage`)

Only the human half of the Home page is persisted — every tile is re-derived from live workload data on each read (see [API.md § Home page](API.md#home-page) and [UI.md § Tab: Home](UI.md#tab-home)). A Wisp with no `homepage` key renders a complete launcher.

```jsonc
{
  "groups": [
    { "id": "c81f…", "name": "Every day", "tiles": ["https://jelly.example.com", "6f2c…"] }
  ],
  "overrides": {
    "https://jelly.example.com": { "hidden": true, "name": "Jellyfin", "iconId": "film" }
  },
  "manualTiles": [
    { "id": "6f2c…", "name": "Router", "url": "https://192.168.1.1", "iconId": "router" }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `groups[]` | `array` | User-defined groups, **in render order** (array order is authoritative — there is no `order` field). Each is `{ id: UUID, name: 1–64 chars, tiles: [tileId] }`; `tiles` is the in-group ordering. The id `ungrouped` is reserved for the implicit bucket and never persisted. |
| `overrides` | `object` | `tileId` → `{ hidden?: true, name?: string, iconId?: string }`. Only the keys the user actually set are stored; an override that would be empty is dropped. |
| `manualTiles[]` | `array` | User-added links: `{ id: UUID, name, url, iconId: string \| null }`. |

Keys are `tileId`s — a derived tile's id is its canonical URL, a manual tile's is its UUID. Read strictly like the rest of the file: a malformed group, tile or override, or a tile id listed by more than one group, fails startup. A group may list a tile that no longer derives; it is simply not rendered.

### Mount object (`mounts[]`)

Common fields:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique id |
| `type` | `string` | `"smb"` or `"disk"`. Discriminates the remaining fields. |
| `label` | `string` | Display name |
| `mountPath` | `string` | Absolute mount point under `/mnt/wisp/` (not `/mnt/wisp` itself) |
| `autoMount` | `boolean` | When `true` (default), Wisp mounts on startup (SMB) or on device insertion (disk). |

SMB-only (`type: "smb"`):

| Field | Type | Description |
|-------|------|-------------|
| `share` | `string` | SMB URL (e.g. `//server/share`) |
| `username` | `string` | SMB user |
| `password` | `string` | SMB password. Never returned by the API — mounts carry `hasPassword` (boolean) instead |

Disk-only (`type: "disk"`):

| Field | Type | Description |
|-------|------|-------------|
| `uuid` | `string` | Filesystem UUID (resolved to `/dev/disk/by-uuid/<uuid>`) |
| `fsType` | `string` | One of `ext4`, `btrfs`, `vfat`, `exfat`, `ntfs3` |
| `readOnly` | `boolean` | Force read-only mount (mandatory for `ntfs3`) |

### Strict reading

(settled 2026-11-12, CODING-RULES §4.) A missing file, or a missing key, takes the defaults above. Anything else wrong fails startup with a message naming the key: invalid JSON, an unknown key at any level (`_comment`, the shipped example's note, is allowed), a wrong type, or an out-of-range value. A typo then shows in `systemctl status wisp` instead of silently becoming a default. On an update, the migration runner checks the config the same way once the migrations have run, so an invalid one fails `step:common-setup` and the updater rolls back before the new backend starts ([UPDATES.md → Runner](UPDATES.md#runner-backendscriptsmigratemjs)).

**What older releases wrote still updates** (settled 2026-11-13). Migration `0007-repair-config-and-records` repairs what earlier releases left, reading the files raw: from `runtime.env` the retired `WISP_BACKEND_PORT` and `WISP_FRONTEND_PORT`; from this file the retired keys `refreshIntervalSeconds`, `networkMounts`, `backupNetworkMountId`, each mount whose `mountPath` is outside `/mnt/wisp/` (logged with the containers that use it), a `backupMountId` naming no mount, and schedule destinations that are neither `'local'` nor the `backupMountId`. Nothing reads the config strictly before it: the migrations before it read their paths tolerantly. A rollback restores `config/` and the migration ledger together, so `0007` runs again on the next update. Anything else invalid is left for the runner's check to report.

The read and the Settings writes share one schema (`backend/src/lib/configSchema.js`): the API refuses (422) what the read would reject, and every write goes through the read's parse before it lands, so a file the UI wrote always boots. A write that removes or swaps the backup mount prunes its references in the same write; an assignment to a removed section still falls back to Main. A file edited by hand while Wisp runs is parsed on the next read, so a broken edit makes settings reads and writes fail until it is fixed.

### Config file permissions

The file may hold secrets (SMB passwords, the OIDC `clientSecret`, API token hashes), so it is kept **`0600`**: `permissions.sh` sets it at install, and every Settings write re-stages the atomic temp file with mode `0600` so a save can't silently widen it back to the umask default.

### Reverse proxy / HTTPS (`trustedProxies`)

Wisp itself serves plain HTTP; TLS is expected to terminate at an optional reverse proxy (Caddy / nginx / Traefik). Wisp derives the request scheme from `X-Forwarded-Proto`, which in turn decides:

- the session cookie's `Secure` flag, and
- the scheme of generated absolute URLs — notably the **OIDC redirect/callback URI** when `advertisedUrl` is not set. If Wisp thinks the request was `http` when the browser used `https`, the callback it sends to the identity provider is `http://…` and the provider rejects it as an invalid callback URL. Setting `advertisedUrl` to the proxy's `https://` URL pins the callback regardless of forwarded headers.

**HTTPS also enables the offline shell.** Service workers only run in a secure context (HTTPS, or `localhost`). Reached over plain HTTP at a LAN IP, `navigator.serviceWorker` is undefined, registration is skipped, and Wisp still works — but a launch made while the server is unreachable (VPN down, app installed to a phone's home screen) cannot render a "Can't reach Wisp" page, because the browser never gets the HTML. Put TLS in front of Wisp if you use it as an installed web app. See [ARCHITECTURE.md](../ARCHITECTURE.md#offline-shell-frontendpublicswjs).

For safety, forwarded headers are honored **only from trusted sources**. Loopback (`127.0.0.1`, `::1`) is always trusted — enough for a proxy on the same host that connects to Wisp over localhost. When the **proxy runs on a different host or container** (so Wisp sees the connection from a LAN/Docker IP), add that source to `trustedProxies`:

```jsonc
// wisp-config.json
"trustedProxies": ["192.168.1.20"]        // the proxy's IP …
"trustedProxies": ["192.168.1.0/24"]      // … or its subnet (CIDR)
```

Entries may be IPv4/IPv6 addresses, CIDR subnets, or the named ranges `loopback` / `linklocal` / `uniquelocal`. An invalid entry fails startup, naming it (settled 2026-11-12: this reverses "a typo must not crash-loop the service" — a dropped entry silently changed the cookie `Secure` flag and the rate-limit key, while a crash-loop is visible in `systemctl status`). This field is read at process start, so **restart Wisp after changing it** (`systemctl restart wisp`); it is not editable from the UI. Also ensure the proxy actually sends the headers (Caddy/Traefik do by default; nginx needs `proxy_set_header X-Forwarded-Proto $scheme;` and `proxy_set_header Host $host;`). **Never** widen this to trust the whole world — an attacker who can reach Wisp directly could otherwise forge `X-Forwarded-For` to defeat the login rate limit.

## Password Storage

Login uses **`config/wisp-password`** (mode `0600`): scrypt hash written by `install.sh` / `wispctl password` / change-password in the UI. JWT signing requires this file; run `wispctl password` if the backend reports no password configured. A file that exists but can't be read, or isn't in the `scrypt:salt:hash` form, fails startup. It is read on each use, so `wispctl password` applies without a restart.

## Filesystem Paths

### Directories created by setup

| Path | Owner | Mode | Purpose |
|------|-------|------|---------|
| `/var/lib/wisp/images/` | `<deploy-user>:libvirt` | `0775` | Image library |
| `/var/lib/wisp/vms/` | `<deploy-user>:libvirt` | `0775` | VM storage |
| `/var/lib/wisp/backups/` | `<deploy-user>:libvirt` | `0775` | Local backups |
| `/var/lib/wisp/containers/` | `<deploy-user>:libvirt` | `0775` | Container storage (when created by setup) |
| `/mnt/wisp/smb/` | `<deploy-user>:libvirt` | `0775` | SMB mount parent |

### Per-VM directory layout

```
<vmsPath>/<vm-name>/
├── disk0.qcow2
├── disk1.qcow2
├── cloud-init.iso
├── cloud-init.json
└── VARS.fd
```

### Backup directory layout

```
<backupPath>/<vm-name>/<timestamp>/
├── manifest.json
├── domain.xml
├── disk0.qcow2.gz
├── VARS.fd
├── cloud-init.iso.gz
└── cloud-init.json
```

## Systemd unit placeholders

Templates in `systemd/` use:

| Placeholder | Value |
|-------------|--------|
| `WISP_USER` | Deploy user |
| `WISP_PATH` | Install directory |

Installed unit is **`wisp.service`**. Optional `EnvironmentFile=-WISP_PATH/config/runtime.env`.
