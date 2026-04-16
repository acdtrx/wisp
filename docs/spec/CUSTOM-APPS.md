# Custom App Containers

Custom App Containers are containers created from hardcoded app templates that provide dedicated configuration UIs instead of generic env vars and mounts sections. Each app has a backend module (validates config, generates derived files) and a frontend component (dedicated form UI).

## Overview

- User picks an app template (or "Generic Container") when creating a container
- The `app` and `appConfig` fields in `container.json` identify the app type and store structured configuration
- The backend app module generates env vars, mounts, and config files from `appConfig`
- The frontend renders a dedicated component instead of the Env and Mounts sections
- Users can "eject" an app container to a generic container (one-way, keeps generated config)

## Data Model

Three optional fields on `container.json`:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `app` | string \| omitted | omitted | App registry ID (e.g. `"caddy-reverse-proxy"`). Immutable after create except via eject. |
| `appConfig` | object \| omitted | omitted | Structured config for the app. Shape is app-specific. Only present when `app` is set. Source of truth — env/mounts/files are derived from it. |
| `pendingRestart` | boolean \| omitted | omitted | Set `true` when `appConfig` changes while container is running. Cleared on start/restart. |

## App Registry

### Backend — `backend/src/lib/linux/containerManager/apps/appRegistry.js`

Maps app IDs to `{ label, description, defaultImage, allowCustomImage, module }`. The `getAppModule(appId)` function returns the module or null.

### Frontend — `frontend/src/apps/appRegistry.js`

Maps app IDs to `{ label, description, defaultImage, allowCustomImage, component }`. Exports `getAppEntry(appId)` and `getAppList()`.

## Backend App Module Interface

Each module (`backend/src/lib/linux/containerManager/apps/<app>.js`) exports:

| Function | Signature | Purpose |
|----------|-----------|---------|
| `getDefaultAppConfig` | `() → appConfig` | Starting appConfig for new containers |
| `validateAppConfig` | `(appConfig) → appConfig` | Validate and normalize. Throws `INVALID_APP_CONFIG` on failure. |
| `generateDerivedConfig` | `(appConfig) → { env, mounts, mountContents }` | Generate derived artifacts from appConfig |
| `maskSecrets` | `(appConfig) → appConfig` | Redact secrets for API responses |
| `getReloadCommand` | `() → string[] \| null` | Optional. Command to live-reload config inside the running container (e.g. `['caddy', 'reload', ...]`). Return `null` if the app doesn't support live reload. |

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

Body gains optional fields: `app` (string, validated against registry) and `appConfig` (object). If `app` is provided without `appConfig`, the module's `getDefaultAppConfig()` is used.

### PATCH /api/containers/:name — Update

- When `config.app` is set and `appConfig` is in the body: validated via app module, derived config regenerated, env/mounts/files replaced.
- When `config.app` is set and `envPatch` or `mounts` is in the body: rejected with `APP_CONFIG_ONLY` (422).
- `{ eject: true }`: removes `app`, `appConfig`, `pendingRestart`. Keeps env/mounts as-is.

### Error Codes (422)

- `INVALID_APP_CONFIG` — appConfig validation failed
- `APP_CONFIG_ONLY` — attempted raw env/mount edit on app container
- `UNKNOWN_APP_TYPE` — app ID not in registry

## Frontend

### Create Flow — CreateContainerPanel

App selector buttons above the name/image form. Selecting an app prefills the image (editable if `allowCustomImage`). The `app` field is included in the POST spec.

### Overview Flow — ContainerOverviewPanel

When `config.app` is set, renders `AppConfigWrapper` (which loads the app's dedicated component) instead of ContainerEnvSection + ContainerMountsSection. Network and General sections remain unchanged.

### AppConfigWrapper

Renders the app component and an "Eject to generic container" button with confirmation dialog.

### App Component Contract

Each app's frontend component receives:
- `config` — full container config (with masked secrets in `appConfig`)
- `onSave(appConfig)` — saves the appConfig via PATCH

Components use SectionCard for consistent styling, handle their own dirty tracking, and follow the secret-field pattern (omit unchanged secrets from the patch).

## Live Reload

When an app module provides `getReloadCommand()`, the backend attempts a live reload after saving `appConfig` on a running container instead of requiring a restart:

1. Config and mount files are written to disk
2. The reload command is executed inside the container via `execCommandInContainer` (non-interactive containerd exec)
3. If the command exits 0: the response includes `{ requiresRestart: false, reloaded: true }` — no restart needed
4. If the command exits non-zero: throws `APP_RELOAD_FAILED` (422) with stderr/stdout as detail — the config is saved but the app rejected it
5. If the exec itself fails (e.g. command not found): falls back to `pendingRestart: true` behavior

Apps that don't support live reload (return `null` from `getReloadCommand`) always use `pendingRestart`.

`execCommandInContainer` is a general-purpose non-interactive exec utility (`containerManagerExec.js`) available for future use beyond app reload.

## Adding a New App

1. **Backend module** — Create `backend/src/lib/linux/containerManager/apps/<app>.js` exporting `{ getDefaultAppConfig, validateAppConfig, generateDerivedConfig, maskSecrets, getReloadCommand }` as a named module object.
2. **Register backend** — Add entry to `APP_REGISTRY` in `apps/appRegistry.js`.
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
- `hosts[]` — Reverse proxy entries. `subdomain` is a DNS label; `target` is IP/hostname with optional port.
- `cloudflareApiToken` — Cloudflare API token for DNS-01 challenge. Stored as secret, masked in API responses as `{ isSet: boolean }`.

### Derived Config

- **env:** `CLOUDFLARE_API_TOKEN` (secret) when token is set
- **mounts:** `Caddyfile` (file → `/etc/caddy/Caddyfile`, readonly), `caddy-data` (dir → `/data`), `caddy-config` (dir → `/config`)
- **Caddyfile:** Generated with wildcard site block, per-host reverse proxy handlers, Cloudflare DNS TLS block (when token set)
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
