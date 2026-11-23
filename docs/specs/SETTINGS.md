# Settings

Settings are split across the Host panel: **App Config** tab (application-wide configuration and password change), **Host Mgmt** tab (network bridge management, **Storage** for SMB/CIFS shares and adopted removable drives, and **Backup** for local path plus optional mount used for backups) and **Software** tab (OS updates). Host information is in the **Overview** tab.

## Settings Fields

| Field | Type | Constraints | Description |
|-------|------|------------|-------------|
| Server name | string or null | — | Display name shown in the top bar. When null or empty in the config file, the API returns **`My Server`**. |
| VM storage path | string | Must start with `/` | Absolute path where per-VM directories are created. |
| Image library path | string | Must start with `/` | Absolute path for the image library. |
| Container storage path | string | Must start with `/` | Absolute root for container bundles (persisted in `wisp-config.json`; not edited in the App Config UI today). |
| Backup local path | string | Must start with `/` | Absolute path for local backups. |
| LAN discovery | boolean | — | Announce this server as a `_wisp._tcp` mDNS service and list other Wisp servers in the top bar. Default **on**. |
| Advertised URL | string or null | Valid `http`/`https` URL, ≤ 251 bytes | Full URL browsers and other Wisp servers use to open this one (e.g. behind a reverse proxy); its origin is also the OIDC callback origin. Empty/null → announce `http://<hostname>.local:<port>`, and OIDC uses the request origin. Invalid URLs are rejected with 422 `INVALID_URL`. |

Settings are persisted in `config/wisp-config.json` ([CONFIGURATION.md](CONFIGURATION.md)); `WISP_CONFIG_PATH` moves it in development and tests only: an installed Wisp refuses the key ([CONFIGURATION.md → Password Storage](CONFIGURATION.md#password-storage)).

**Saving and live updates (settled 2026-11-22).** A save answers with an ack (API.md, Command responses); every tab reloads settings when the `changes` topic names them, a mount add, edit or remove included (mounts live in this record). The settings pages show the saved settings as text. A group's Edit opens a form holding the values as they were when it opened; its Save sends only what changed, and a failed save keeps the form open with the server's message. The last save wins. A setting that is a plain on/off (LAN discovery, scheduled backups, SSO) is a switch that acts at once.

## Single sign-on (`oidc`)

Configured in **Host → App Config → Single sign-on** (issuer URL, client ID and client secret in its form; a switch turns SSO on, off with its reason until all three are stored). Saved through `PATCH /api/settings/oidc`, which requires a browser session — API tokens cannot change SSO (settled 2026-10-16, see [AUTH.md](AUTH.md) § Denied surfaces). The client secret is write-only: the field stays blank with a "saved" placeholder, and leaving it blank keeps the saved secret. Changing the issuer or client ID marks the secret required — the saved one is never reused for a different provider. Behavior and validation: [AUTH.md](AUTH.md) § OIDC.

## SSH keys (`sshKeys`)

Wisp keeps a list of SSH public keys, for the VMs it sets up (settled 2026-11-21). A key
has a name, its text, and whether it is a default for new VMs; several may be. The list
shows on App Config, each key with its type and fingerprint.

- **Add**: paste one public key, with an optional name. Without one the name is the key's
  own comment, or a generic one. The same key (its type and data, whatever its comment)
  is not stored twice. A key is taken only whole: a cut, wrapped or doubled paste is
  refused, and a private key is refused with a message of its own.
- **Import from GitHub**: the keys of one GitHub user, fetched by the server through the
  SSRF guard ([IMAGE-LIBRARY.md](IMAGE-LIBRARY.md#ssrf-protection)), rate-limited to 10
  requests a minute per IP. Keys already in the list, and keys of a type Wisp does not take, are skipped and
  counted.
- **Rename, mark default, remove.** Remove asks first.
- **A VM keeps its own copy** of the keys it was given ([CLOUD-INIT.md](CLOUD-INIT.md)):
  removing or renaming a key in the list changes no VM. New VM preselects the default
  keys; a VM's first boot setup picks from the list, and a key pasted there is added to
  it.

The routes: [API-HOST.md](API-HOST.md), Settings.

## Storage (`mounts`)

Configured in **Host → Host Mgmt → Storage**: SMB shares and adopted removable drives, each with **Mount**, **Unmount**, and (SMB only) **Check**, and its status (mounted or not). The mount object: [STORAGE.md → Data model](STORAGE.md#data-model). The routes: [API-HOST.md](API-HOST.md).

### Password masking

SMB passwords never leave the server: `GET /api/settings` and `GET /api/host/mounts` return `hasPassword` (boolean) in place of `password`. When saving, an omitted or empty `password` preserves the stored one.

## Backup (`backupLocalPath`, `backupMountId`)

Configured in **Host → Host Mgmt → Backup**.

| Setting | Description |
|---------|-------------|
| `backupLocalPath` | Local directory for backups (always available as a destination in the backup modals). |
| `backupMountId` | Optional. If set to a mount `id` from `mounts`, that mount appears as a second destination in the backup modals and in Scheduled backups. Any mount can be picked, an SMB share or an adopted drive (settled 2026-11-22). None means no extra destination is offered for backups. |

VM backups still require the VM to be stopped; container backups pause a running container for the duration of the archive instead. The modals list **Local** plus at most one extra destination when `backupMountId` is set.

## Scheduled backups (`backupSchedule`)

Configured in **Host → Host Mgmt → Scheduled backups**: a switch turns the schedule on, and the form holds the time, the destinations and how long to keep (a number out of range is refused with a reason). Runs a daily backup of every container with the nightly backup switched on (the container page's Start-up and backups group).

| Setting | Description |
|---------|-------------|
| `enabled` | Master switch (default off). |
| `time` | Daily fire time, `HH:MM` 24-hour, host-local (default `03:00`). |
| `destinationIds` | Where scheduled backups go — Local and/or the configured backup mount (default `["local"]`; at least one required). |
| `retainDays` | Keep the newest scheduled backup per day for this many days (default 7, range 1–365). |
| `retainWeeks` | Beyond the daily window, keep one scheduled backup per week for this many weeks (default 4, range 0–52). |

Manual backups are never auto-pruned. The scheduler runs only while the backend is up — a missed time is skipped until the next day. Full semantics in [BACKUPS.md → Scheduled backups](BACKUPS.md#scheduled-backups).

## LAN Discovery (`discoveryEnabled`, `advertisedUrl`)

Configured in **Host → App Config**. When enabled (default), the backend announces this instance on the LAN and lists discovered peer instances in the top bar. Saving settings re-announces immediately (no restart). Full behavior in [DISCOVERY.md](DISCOVERY.md).

`advertisedUrl` is also the origin of the OIDC callback URL when set — see [AUTH.md](AUTH.md) § OIDC.

## Password Change

The Host → App Config tab includes a password change: the user enters the current password and a new one, the backend verifies the current password and writes the new one to `config/wisp-password` (mode `0600`). Changing the password invalidates all existing JWT tokens (the signing secret is derived from the password).

## OS Updates

OS update check and upgrade are in the **Host → Software** tab ([HOST-MONITORING.md → OS updates](HOST-MONITORING.md#os-updates)). Uses apt: Wisp hosts run Debian or Ubuntu.

A background hourly check runs automatically; when updates are available, a badge is shown on the Host entry (left panel) and on the Software tab. The timestamp of the last successful check is exposed as `updatesLastChecked` in the stats SSE and displayed in the UI as a relative time. If `/usr/local/bin/wisp-os-update` is missing, the feature returns 503.

## Network Bridges

Host → Host Mgmt includes a **Network Bridges** section for managed VLAN bridge creation/deletion: an eligible parent bridge (non-VLAN uplink bridge, e.g. `br0`) and a VLAN ID (`1..4094`). Bridge name is auto-generated as `<base>-vlan<id>` (for example `br0-vlan10`).

The host bridge performs VLAN tagging; VMs and containers attach to the managed bridge as normal untagged interfaces.

Safety rules:

- Parent bridge cannot be VLAN-tagged
- Parent bridge must have at least one non-VLAN member interface
- Managed bridge delete is blocked when referenced by VM NICs or container `network.interface`
