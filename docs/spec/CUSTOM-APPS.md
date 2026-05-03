# Custom App Containers

Custom App Containers are containers created from hardcoded app templates that provide dedicated configuration UIs instead of generic env vars and mounts sections. Each app has a backend module (validates config, generates derived files) and a frontend component (dedicated form UI).

**Architecture note:** App orchestration lives in `backend/src/lib/containerApps/`, a peer of routes and a *consumer* of containerManager. containerManager itself has zero knowledge of apps — it persists arbitrary `metadata` verbatim and exposes the primitives (createContainer, updateContainerConfig, putMountFileTextContent, execCommandInContainer) that containerApps composes into the app create/patch/eject flows.

## Overview

- User picks an app template (or "Generic Container") when creating a container
- containerApps validates the choice, computes derived env/mounts/devices/files, and writes them by calling containerManager primitives
- App identity lives in `container.json.metadata.app` (string id) and `container.json.metadata.appConfig` (object)
- The frontend renders a dedicated component instead of the Env and Mounts sections when `config.metadata?.app` is set
- Users can "eject" an app container to a generic container — clears `metadata.app`/`metadata.appConfig`, leaves env/mounts/devices/files in place

## Data Model

`container.json` carries an opaque `metadata` field that containerManager persists but never introspects. containerApps writes app identity into it:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `metadata.app` | string \| omitted | omitted | App registry ID (e.g. `"caddy-reverse-proxy"`). Immutable after create except via eject. |
| `metadata.appConfig` | object \| omitted | omitted | Structured config for the app. Shape is app-specific. Only present when `metadata.app` is set. Source of truth — env/mounts/files are derived from it. |
| `pendingRestart` | boolean \| omitted | omitted | Top-level field. Set `true` when an `appConfig` change can't be applied via live reload while the container is running, or when generic config changes (mounts, env, network) require a restart. Cleared on start/restart. |

## App Registry

### Backend — `backend/src/lib/containerApps/appRegistry.js`

Maps app IDs to `{ label, description, defaultImage, allowCustomImage, module, requiresRoot? }`. `getAppModule(appId)` returns the module or null; `getAppEntry(appId)` returns the full entry (used by `createAppContainer` to read flags like `requiresRoot`). Re-exported from `containerApps/index.js`.

**`requiresRoot: true`** is included in the expanded spec as `runAsRoot: true` when containerApps creates the container. Use for apps that need UID 0 inside the container — binding privileged ports, calling `setuid` per session, or writing to root-owned dirs in the image (smbd, OpenWebUI, etc.). Without this flag, the user has to toggle General → runAsRoot manually after create.

**`defaultServices: [{ port, type, txt }]`** is passed through containerApps into the create spec so containerManager seeds `container.services[]` at create time and the app's mDNS records publish out of the box (e.g. `_smb._tcp` for tiny-samba, `_https._tcp` for Caddy). After create the user owns the services list — PATCH does not re-seed, and the Services section can edit/remove any of these entries.

### Frontend — `frontend/src/apps/appRegistry.js`

Maps app IDs to `{ label, description, defaultImage, allowCustomImage, component }`. Exports `getAppEntry(appId)` and `getAppList()`.

## Backend App Module Interface

Each module (`backend/src/lib/containerApps/<app>.js`) exports:

| Function | Signature | Purpose |
|----------|-----------|---------|
| `getDefaultAppConfig` | `(context?) → appConfig` | Starting appConfig for new containers. The optional `context` is `{ containerName }`, passed by the create flow so apps can derive sensible defaults from the container name (e.g. tiny-samba uses it for `server.netbiosName`). |
| `validateAppConfig` | `(appConfig, oldAppConfig?) → appConfig` | Validate and normalize. Throws `INVALID_APP_CONFIG` on failure. The optional second arg lets the module merge unchanged secrets forward (`maskSecrets` strips them on output, so the frontend can't round-trip them). For create, `oldAppConfig` is `null`. |
| `generateDerivedConfig` | `(appConfig) → { env, mounts, mountContents, appConfig? }` | Generate derived artifacts from appConfig. May return a transformed `appConfig` (e.g. zot stores hashed passwords back into appConfig). |
| `maskSecrets` | `(appConfig) → appConfig` | Redact secrets for API responses |
| `getReloadCommand` | `() → string[] \| null` | Optional. Command to live-reload config inside the running container (e.g. `['caddy', 'reload', ...]`). Return `null` if the app doesn't support live reload. |
| `requiresRestartForChange` | `(oldAppConfig, newAppConfig) → boolean` | Optional. Returns `true` when the diff includes fields that the app's reload can't apply live (e.g. tiny-samba's `server.workgroup`). When true, the backend sets `pendingRestart: true` and reports `requiresRestart: true` even after a successful reload. |

### generateDerivedConfig return shape

```js
{
  env: { KEY: { value: string, secret?: boolean } },        // replaces config.env entirely
  mounts: [{ type, name, containerPath, readonly }],         // replaces config.mounts entirely
  mountContents: { mountName: 'file content string' },       // written to files/<mountName>
}
```

## API Changes

### POST /api/containers — Create

Body gains optional fields: `app` (string, validated against registry) and `appConfig` (object). If `app` is provided without `appConfig`, the module's `getDefaultAppConfig()` is used. The route dispatches to `containerApps.createAppContainer(spec)` which expands the spec (validates appConfig, calls `generateDerivedConfig`, builds spec with `metadata.app`/`metadata.appConfig`/`env`/`mounts`/`devices`/`services`/`runAsRoot`) and then calls `containerManager.createContainer`. Mount file contents from `derived.mountContents` are written via `containerManager.putMountFileTextContent` after create. On any failure after create, the container is rolled back.

### PATCH /api/containers/:name — Update

The route reads `config.metadata?.app` and dispatches:

- `{ appConfig }` on an app container → `containerApps.applyAppConfig(name, appConfig)`. Validates via app module, regenerates derived config, persists new `metadata.appConfig` + `env`/`mounts`/`devices`, writes mount file contents, attempts live reload if running.
- `{ envPatch }` / `{ env }` / `{ mounts }` / `{ devices }` on an app container → rejected with `APP_CONFIG_ONLY` (422). Enforced at the route layer.
- `{ eject: true }` on an app container → `containerApps.eject(name)`. Clears `metadata.app`/`metadata.appConfig`. Env, mounts, devices, files all preserved.
- Anything else → straight through to `containerManager.updateContainerConfig`.

### Error Codes (422)

- `INVALID_APP_CONFIG` — appConfig validation failed
- `APP_CONFIG_ONLY` — attempted raw env/mount edit on app container
- `UNKNOWN_APP_TYPE` — app ID not in registry

## Frontend

### Create Flow — CreateContainerPanel

App selector buttons above the name/image form. Selecting an app prefills the image (editable if `allowCustomImage`). The `app` field is included in the POST spec.

### Overview Flow — ContainerOverviewPanel

When `config.metadata?.app` is set, renders `AppConfigWrapper` (which loads the app's dedicated component) instead of ContainerEnvSection + ContainerMountsSection. Network and General sections remain unchanged.

### AppConfigWrapper

Renders the app component and an "Eject to generic container" button with confirmation dialog.

### App Component Contract

Each app's frontend component receives:
- `config` — full container config (with masked secrets in `appConfig`)
- `onSave(appConfig)` — saves the appConfig via PATCH

Components use SectionCard for consistent styling, handle their own dirty tracking, and follow the secret-field pattern (omit unchanged secrets from the patch).

## Live Reload

`containerApps.applyAppConfig` orchestrates live reload after persisting the new appConfig on a running container:

1. New appConfig validated; `generateDerivedConfig` produces new env/mounts/devices/mountContents
2. `containerManager.updateContainerConfig` persists the metadata + env/mounts/devices changes (manager handles backing-store cleanup for removed mounts generically)
3. Mount file contents written via `containerManager.putMountFileTextContent`
4. Container task state checked via `containerManager.getTaskState`; if not running, return immediately
5. If the app module provides `getReloadCommand()`, run it via `containerManager.execCommandInContainer` (non-interactive containerd exec)
6. If the command exits 0: response includes `{ requiresRestart, reloaded: true }`. `requiresRestart` is true when the app module's `requiresRestartForChange` hook returns true OR the mount layout changed structurally.
7. If the command exits non-zero: throws `APP_RELOAD_FAILED` (422) with stderr/stdout as detail — config saved, app rejected the new state
8. If the exec itself fails for a non-app reason (e.g. command not found): falls back to setting `pendingRestart: true` and returning `{ requiresRestart: true }`

Apps that don't supply `getReloadCommand` always set `pendingRestart` instead of attempting reload.

**Mount layout vs file contents.** Live reload covers *file contents* but not *bind mount layout*. Bind mounts are captured in the OCI spec at task create — adding/removing a share, retargeting `subPath`, resizing tmpfs cannot apply to a running task via reload. containerApps compares the structural mount signature (type/name/containerPath/sourceId/subPath/sizeMiB) before vs after `generateDerivedConfig` and forces `pendingRestart: true` when it differs, even if the reload command returned exit 0. OR-combined with the app module's `requiresRestartForChange` hook.

`execCommandInContainer` is a general-purpose non-interactive exec utility (`containerManagerExec.js`) — exposed on the containerManager facade for any caller, not specific to app reload.

## Adding a New App

1. **Backend module** — Create `backend/src/lib/containerApps/<app>.js` exporting `{ getDefaultAppConfig, validateAppConfig, generateDerivedConfig, maskSecrets, getReloadCommand }` as a named module object.
2. **Register backend** — Add entry to `APP_REGISTRY` in `containerApps/appRegistry.js`.
3. **Frontend component** — Create `frontend/src/apps/<app>/<AppName>Section.jsx` using SectionCard.
4. **Register frontend** — Add entry to `APP_REGISTRY` in `frontend/src/apps/appRegistry.js`.
5. **Update docs** — Add the app's `appConfig` schema and behavior to this file.

## Eject

Eject converts an app container to a generic container. The `app` and `appConfig` fields are removed; generated env vars and mounts become directly editable. This is a one-way operation.

---

## App: Caddy Reverse Proxy

**ID:** `caddy-reverse-proxy`
**Default image:** `caddy:latest` (custom image allowed)

### appConfig Schema

```json
{
  "domain": "example.com",
  "hosts": [
    { "subdomain": "ha", "target": "192.168.1.100" },
    { "subdomain": "plex", "target": "192.168.1.101:32400" }
  ],
  "cloudflareApiToken": "cf-token"
}
```

- `domain` — Base domain for wildcard certificate (e.g. `example.com`)
- `hosts[]` — Reverse proxy entries. `subdomain` is a DNS label; `target` is IP/hostname with optional port (also accepts `scheme://host[:port][/path]`). The Caddyfile is generated with `target` interpolated into a `reverse_proxy` directive, so the validator rejects `\n` / `\r` / `{` / `}` and any shape that doesn't match `host[:port]` or `scheme://host[:port][/path]`. Returns **422 INVALID_APP_CONFIG** otherwise.
- `cloudflareApiToken` — Cloudflare API token for DNS-01 challenge. Stored as secret, masked in API responses as `{ isSet: boolean }`.

### Derived Config

- **env:** `CLOUDFLARE_API_TOKEN` (secret) when token is set
- **mounts:** `Caddyfile` (file → `/etc/caddy/Caddyfile`, readonly), `caddy-data` (dir → `/data`), `caddy-config` (dir → `/config`)
- **Caddyfile:** Generated with wildcard site block, per-host reverse proxy handlers, Cloudflare DNS TLS block (when token set), and a global log filter that routes `http.handlers.reverse_proxy` logs to a separate logger capped at `ERROR` (suppresses the per-disconnect `aborting with incomplete response` WARN that SSE-heavy apps like Wisp trigger on every client refresh or navigation)
- **Reload:** `caddy reload --config /etc/caddy/Caddyfile` — live reload without restart

---

## App: Zot OCI Registry

**ID:** `zot-registry`
**Default image:** `ghcr.io/project-zot/zot-linux-amd64:latest` (custom image allowed)

### appConfig Schema

```json
{
  "users": [
    { "username": "admin", "hash": "$6$..." }
  ]
}
```

- `users[]` — htpasswd authentication entries. When empty, the registry allows anonymous push/pull. Passwords are hashed with SHA-512 crypt on save; only hashes are stored in `appConfig`. Masked in API responses as `{ username, hasPassword }`.

When adding or updating a user, send `{ username, password }` — the backend hashes the password and stores only the hash. To keep an existing password, omit the `password` field.

### Derived Config

- **env:** (none)
- **mounts:** `config-json` (file → `/etc/zot/config.json`, readonly), `registry` (dir → `/var/lib/registry`), optionally `htpasswd` (file → `/etc/zot/htpasswd`, readonly) when users are configured
- **config.json:** Generated zot config with storage and HTTP settings; htpasswd auth block when users exist
- **Reload:** Not supported — config changes require container restart

---

## App: Tiny Samba

**ID:** `tiny-samba`
**Default image:** `ghcr.io/acdtrx/tiny-samba:latest` (custom image allowed)
**Registry flags:** `requiresRoot: true` — smbd needs UID 0 to bind 445 and `setuid` per session, so the container is created with `runAsRoot: true` automatically. `defaultServices: [{ port: 445, type: '_smb._tcp', txt: {} }]` — `<container>.local` advertises as an SMB host out of the box.

### appConfig Schema

```json
{
  "server": {
    "workgroup": "WORKGROUP",
    "netbiosName": "tiny-samba",
    "dataUid": 1000,
    "minProtocol": "SMB3",
    "iconModel": "TimeCapsule6,106"
  },
  "users": [
    { "name": "alice", "password": "hunter2" },
    { "name": "bob",   "password": "$NT$8846F7EAEE8FB117AD06BDD830B7586C" }
  ],
  "shares": [
    {
      "name": "documents",
      "guest": false,
      "source": null,
      "access": [
        { "user": "alice", "level": "rw" },
        { "user": "bob",   "level": "ro" }
      ]
    },
    {
      "name": "archive",
      "guest": false,
      "source": { "sourceId": "usb-4tb", "subPath": "samba/archive" },
      "access": [{ "user": "alice", "level": "rw" }]
    },
    { "name": "public", "guest": true, "source": null, "access": [] }
  ]
}
```

- `server.workgroup` / `server.netbiosName` — 1–15 chars, alphanumeric + `_`/`-`. Changes need a task restart (smbd-level config).
- `server.dataUid` — UID inside the container that owns share data. Combined with the container's `runAsRoot: true` mount idmap, the host-side files are owned by the wisp deploy user. Changes need a task restart.
- `server.minProtocol` — `SMB1` / `SMB2` / `SMB3`. Live-reloadable.
- `server.iconModel` — Apple SMB extensions toggle. `"TimeCapsule6,106"` (default) enables `vfs_fruit` + `streams_xattr` for nicer macOS Finder behaviour and Time Capsule icon; `"-"` disables AAPL extensions entirely. Use `"-"` as a workaround when uploads fail with `fruit_pwrite_meta_stream … No such file or directory` on a backing filesystem where `streams_xattr` misbehaves.
- `users[].name` — lowercase, starts with a letter, only `[a-z0-9._-]`. `users[].password` accepts plaintext or `$NT$<32 hex>`. Stored as-is in `appConfig` (no hashing — tiny-samba's `pdbedit` accepts both forms). Masked in API responses as `{ name, password: { isSet: bool } }`. PATCH bodies that omit `password` for an existing user keep the prior value (merged forward by `validateAppConfig(new, old)`).
- `shares[].name` — lowercase DNS label (`[a-z0-9-]`); SMB share name visible to clients. The in-container mount path is fixed at `/shares/<name>` by convention (no user-visible field — it's an implementation detail). Each share fans out to its own wisp directory mount (named `share-<name>`).
- `shares[].source` — optional `{ sourceId, subPath }`. When set, the share is bound from a wisp storage mount (SMB share, removable drive, etc.) — `sourceId` references an entry in `settings.mounts`, `subPath` is a relative path inside that mount root. When `null`, the share is backed by the container's local files dir.
- `shares[].guest: true` — anonymous, read-only access (tiny-samba enforces RO at smbd). The per-user `access` list is dropped on save when guest is on.
- `shares[].access[].level` — `rw` or `ro`. Non-guest shares require at least one access entry — the validator (and the UI guard) rejects empty access lists with `INVALID_APP_CONFIG`.

### Derived Config

- **env:** (none)
- **mounts:**
  - `tiny-samba-config` (file → `/etc/tiny-samba/config.yaml`, readonly)
  - `tiny-samba-passwords` (file → `/etc/tiny-samba/passwords.yaml`, readonly)
  - `tiny-samba-state` (tmpfs → `/var/lib/samba`, 64 MiB) — smbd's tdb runtime state, gone on restart
  - `share-<name>` (directory → `/shares/<name>`, owner uid:gid = `server.dataUid`) — one per declared share, optionally backed by a storage mount via `source: { sourceId, subPath }`
- **config.yaml:** Generated YAML — `server` block with snake_case fields, `users` list, `shares` map (each with `path`, optional `comment`, `guest: true` OR `access` map)
- **passwords.yaml:** `name: password` map (passwords double-quoted; plaintext or `$NT$` hash passes through)
- **Reload:** `tiny-samba reload` — applies live for users, passwords, shares, access, min protocol. Server-level changes (`workgroup`, `netbiosName`, `dataUid`) flip `requiresRestartForChange` and the badge stays until restart.
