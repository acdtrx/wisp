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
| `pendingRestart` | `{ since }` \| omitted | omitted | Top-level field (see [CONTAINERS.md → Config changes that need a restart](CONTAINERS.md#config-changes-that-need-a-restart)). Set (through `setContainerPendingRestart`) when an `appConfig` change can't be applied via live reload while the container is running, or when generic config changes (mounts, env, network) require a restart. Dropped once the task is seen to have started after `since`. |

## App Registry

### Backend — `backend/src/lib/containerApps/appRegistry.js`

Maps app IDs to `{ label, description, defaultImage, allowCustomImage, module, requiresRoot? }`. `getAppModule(appId)` returns the module or null; `getAppEntry(appId)` returns the full entry or null; `isKnownApp(appId)` — all three match own registry keys only (`Object.hasOwn`), so an id like `constructor` is unknown rather than resolving through the object prototype (used by `createAppContainer` to read flags like `requiresRoot`). Re-exported from `containerApps/index.js`.

**`requiresRoot: true`** is included in the expanded spec as `runAsRoot: true` when containerApps creates the container. Use for apps that need UID 0 inside the container — binding privileged ports, calling `setuid` per session, or writing to root-owned dirs in the image (smbd, OpenWebUI, etc.). Without this flag, the user has to toggle General → runAsRoot manually after create.

**`defaultServices: [{ port, type, txt }]`** is passed through containerApps into the create spec so containerManager seeds `container.services[]` at create time and the app's mDNS records publish out of the box (e.g. `_smb._tcp` for tiny-samba, `_https._tcp` for Caddy). After create the user owns the services list — PATCH does not re-seed, and the Services section can edit/remove any of these entries.

### Frontend — `frontend/src/apps/appRegistry.js`

Maps app IDs to `{ label, description, defaultImage, allowCustomImage, component }`. Exports `getAppEntry(appId)` and `getAppList()`.

## Backend App Module Interface

Each module (`backend/src/lib/containerApps/<app>.js`) exports:

| Function | Signature | Purpose |
|----------|-----------|---------|
| `getDefaultAppConfig` | `(context?) → appConfig` | Starting appConfig for new containers. The optional `context` is `{ containerName }`, passed by the create flow so apps can derive sensible defaults from the container name (e.g. tiny-samba uses it for `server.netbiosName`). |
| `validateAppConfig` | `(appConfig, oldAppConfig?) → appConfig` | Validate and normalize. Throws `INVALID_APP_CONFIG` on failure. For create, `oldAppConfig` is `null`. **Any module with a secret must use the second arg to merge it forward.** `maskSecrets` strips secrets on output, so a form that doesn't retype one omits it — a module that ignores `oldAppConfig` silently blanks the stored value on every unrelated save. Corollary: never trust a secret (or a password hash) that arrives from the client when the stored config already has one. |
| `generateDerivedConfig` | `(appConfig) → { env, mounts, mountContents, appConfig? }` | Generate derived artifacts from appConfig. May return a transformed `appConfig` (e.g. zot stores hashed passwords back into appConfig). |
| `getMountRenames` | `(newAppConfig, oldAppConfig) → { oldMountName: newMountName }` | Optional. Mounts the app means to **rename** in this save, given the raw incoming appConfig (called after `validateAppConfig`). Needed by any app whose derived mount *names* come from user-editable fields: without it a rename reads as "drop the old mount, add a new one" and the old mount's data is deleted. Passed to `updateContainerConfig` as `mountRenames`, so Local data moves to the new name. Absent = the app never renames mounts (fixed names, or Storage-only like jellyfin libraries). |
| `maskSecrets` | `(appConfig) → appConfig` | Redact secrets for API responses |
| `getSecretMountNames` | `(appConfig) → string[]` | Optional. File mounts whose generated content is a secret, for this appConfig — write-only on every surface (see [Mount content routes](#mount-content-routes)). **An app that writes a secret into a file mount must list it**; absent = no secret files. Pure and sync (called on every detail read). |
| `getReloadCommand` | `() → string[] \| null` | Optional. Command to live-reload config inside the running container (e.g. `['caddy', 'reload', ...]`). Return `null` if the app doesn't support live reload. |
| `requiresRestartForChange` | `(oldAppConfig, newAppConfig) → boolean` | Optional. Returns `true` when the diff includes fields that the app's reload can't apply live (e.g. tiny-samba's `server.workgroup`). When true, the backend sets `pendingRestart` and reports `requiresRestart: true` even after a successful reload. |
| `agentWritableAppConfigFields` | `string[]` | Optional. Top-level appConfig keys the MCP `update_app_config` tool may change (see [MCP.md](MCP.md)). Absent or empty = the app is not agent-configurable. Never list secrets, certificate identity, or auth settings — the point of the filter is that an agent can't touch them by mistake (caddy lists only `hosts`). The UI/REST surface is unaffected. |
| `getPublishedLinks` | `(appConfig) → [{ url, target?, label? }]` | Optional. URLs this app makes reachable, for the Home page launcher (see [UI.md § Tab: Home](UI.md#tab-home)). Absent = the app publishes nothing. Return only what the config *proves* exists — an empty array when the relevant fields are unset — and never throw: a malformed appConfig must not take the launcher down. |

### getPublishedLinks

The Home page iterates **every** container carrying `metadata.app` and asks its module for links; no container name is ever hardcoded, so zero, one, or many instances of an app all work.

- **`url`** — absolute `http`/`https`. It is canonicalized (host lowercased, default port and bare trailing slash dropped) and becomes the tile's id.
- **`target`** — set it when the URL fronts *something else*, and carry through whatever the config holds (`host`, `host:port`, or `scheme://host[:port][/path]`). The Home page resolves it against workload hostnames to give the tile live state, and renders a stateless external tile when it resolves to nothing. **Omit `target` when the URL is the container's own address** — the tile then joins to the publishing container itself. Getting this backwards matters: a reverse proxy that omitted `target` would light its own lantern for every host it proxies off-box.
- **`label`** — optional display name. Omit it to let the tile name itself from the workload it points at (or the URL's first hostname label).

Implemented by: **caddy-reverse-proxy** (one link per `hosts[]` entry → `https://<subdomain>.<domain>`, `target` carried), **jellyfin** (`publishedUrl`, no target), **zot-registry** (`externalUrl`, no target). **tiny-samba** publishes no HTTP surface and omits the method.

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

Body gains optional fields: `app` (string, validated against registry) and `appConfig` (object). If `app` is provided without `appConfig`, the module's `getDefaultAppConfig()` is used. The route dispatches to `containerApps.createAppContainer(spec)` which expands the spec (validates appConfig, calls `generateDerivedConfig`, builds spec with `metadata.app`/`metadata.appConfig`/`env`/`mounts`/`devices`/`services`/`runAsRoot`) and then calls `containerManager.createContainer`. Mount file contents from `derived.mountContents` are written via `containerManager.putMountFileTextContent` after create. On any failure after create, the container is rolled back. It resolves with `createContainer`'s `{ name }` — the create job's completion payload.

### PATCH /api/containers/:name — Update

The route reads `config.metadata?.app` and dispatches:

- `{ appConfig }` on an app container → `containerApps.applyAppConfig(name, appConfig)`. Validates via app module, regenerates derived config, persists new `metadata.appConfig` + `env`/`mounts`/`devices`, writes mount file contents, attempts live reload if running.
- `{ envPatch }` / `{ env }` / `{ mounts }` on an app container → rejected with `APP_CONFIG_ONLY` (422), as is `{ devices }` sent alongside `appConfig`. Enforced at the route layer. `{ devices }` on its own is accepted — the Devices section is shown on every container — but an app module that derives devices (Jellyfin's GPU toggle) replaces them on its next `appConfig` save.
- `{ eject: true }` on an app container → `containerApps.eject(name)`. Clears `metadata.app`/`metadata.appConfig`. Env, mounts, devices, files all preserved; the mounts the app declared secret get a stored `secret: true` first.
- Anything else → straight through to `containerManager.updateContainerConfig`.

### Mount content routes

An app container's mounts belong to its app module (create and `applyAppConfig` write the whole `mounts` list from `generateDerivedConfig`, and file contents are regenerated from appConfig on every save). Two separate rules, both for every caller (settled 2026-10-16 — P5.2 replaced the earlier refuse-everything guard, whose read half special-cased apps and left secrets in generic containers' file mounts readable):

- **Writes are refused.** `PUT …/content`, `POST …/file`, and row `PATCH /mounts/:mountName` on a mount of a container whose `metadata.app` resolves to a registered module → `APP_CONFIG_ONLY` (422). A raw write would desync disk from appConfig and be overwritten on the next save; a row rename would move a declared secret file out from under its declared name. Guard: `containerApps.assertMountNotAppManaged(config, mountName)`. An unregistered `metadata.app` owns no mounts (the UI shows the generic Mounts section for it too). Internal writes (`createAppContainer` / `applyAppConfig`) call `containerManager.putMountFileTextContent` directly and are unaffected.
- **Reads follow the secret rule.** `GET …/content` is refused (403 `CONTAINER_MOUNT_SECRET`) for a secret file mount — a stored `secret: true`, **or** a name the app module lists in `getSecretMountNames(appConfig)` — and allowed otherwise, so non-secret app files (Caddy's `Caddyfile`, tiny-samba's `config.yaml`, zot's `config.json` without OIDC) are readable again. Guard: `containerApps.assertMountContentReadable(config, mountName)`. The app's declaration is read from the stored appConfig on every request — app containers carry no stored flag, which is why existing app containers are covered with no migration and no manual step. Container detail and MCP `get_container` mark the same mounts `secret: true` with `isSet` / `sizeBytes` ([CONTAINERS.md § Secret file mounts](CONTAINERS.md#secret-file-mounts)).

The trade-off of declaring secrets (rather than refusing every app file) is that a new app writing a secret into a file mount must list it in `getSecretMountNames`; see [Adding a New App](#adding-a-new-app).

### Error Codes (422)

- `INVALID_APP_CONFIG` — appConfig validation failed
- `APP_CONFIG_ONLY` — attempted raw env/mount edit on app container, or a raw write (content PUT, file upload, row PATCH) to an app-managed mount (reads of secret app files are 403 `CONTAINER_MOUNT_SECRET` instead — see above)
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
2. If a reload will be attempted (running + reload command + no env change), the backing content of every local file mount is snapshotted first — the rollback state for step 7
3. `containerManager.updateContainerConfig` persists the metadata + env/mounts/devices changes in one write — the derived env as an `envPatch` that turns the stored env into exactly the derived set (the manager accepts env changes only as `envPatch`; a flat `env` is rejected for every caller) — with the module's `getMountRenames` as `mountRenames` (renamed Local mounts move their data). It deletes nothing: Local mounts the new config drops keep their data and come back as `removedMounts`
4. Mount file contents written via `containerManager.putMountFileTextContent`
5. Container task state checked via `containerManager.getTaskState`; if not running, return immediately
6. If any env var changed, **skip the reload** and set `pendingRestart` (see *Env vars never reload* below). Otherwise, if the app module provides `getReloadCommand()`, run it via `containerManager.execCommandInContainer` (non-interactive containerd exec)
7. If the command exits 0: the data of `removedMounts` is deleted (`deleteRemovedMountData`) and the response includes `{ requiresRestart, reloaded: true }`. `requiresRestart` is true when the app module's `requiresRestartForChange` hook returns true, OR the mount layout changed structurally.
8. If the command exits non-zero: **rolls back** the persisted config (metadata/env/mounts/devices) and mount file contents to the step-2 snapshot — renames are reversed (data moves back), mounts only the rejected config had lose the backing stores this save created, and dropped mounts still have their data because step 7 never ran — then throws `APP_RELOAD_FAILED` (422). The app rejected the new state and kept serving its previous config (reload commands judge-then-apply), so the rollback re-syncs disk with what is actually running — without it, the next restart/autostart/reboot would boot the container into a config its own app already refused. The detail is built by `reloadFailureDetail()`, which keeps the lines that look like errors and otherwise falls back to the **tail** of the output: reload tools narrate before they fail (`caddy reload` emits three JSON log lines first), so a head-truncated detail shows noise and cuts the diagnosis. If the rollback itself fails, the error detail says so and the persisted config may not match the running app.
9. If the exec itself fails for a non-app reason (e.g. command not found): falls back to setting `pendingRestart` and returning `{ requiresRestart: true }` — no rollback; the app never judged the config

Every path that keeps the new config (not running, env changed / no reload command, reload accepted, exec failure) deletes the `removedMounts` data before returning; only the `APP_RELOAD_FAILED` rollback skips it (settled 2026-10-16 — data of a dropped mount is deleted only once the config that dropped it stands, so a rejected save never costs data).

Apps that don't supply `getReloadCommand` always set `pendingRestart` instead of attempting reload.

**Mount layout vs file contents.** Live reload covers *file contents* but not *bind mount layout*. Bind mounts are captured in the OCI spec at task create — adding/removing a share, retargeting `subPath`, resizing tmpfs cannot apply to a running task via reload. containerApps compares the structural mount signature (type/name/containerPath/sourceId/subPath/sizeMiB) before vs after `generateDerivedConfig` and forces `pendingRestart` when it differs, even if the reload command returned exit 0. OR-combined with the app module's `requiresRestartForChange` hook.

**Env vars never reload.** Same reason, sharper edge: the OCI process env is built from `config.env` when the task starts (`containerManagerSpec.js`), so a running process keeps the environment it was exec'd with. No reload command can change it. containerApps compares an env signature (name + value; the `secret` flag is presentation-only) and, on any diff, **skips the reload entirely** and sets `pendingRestart`.

Skipping matters — a reload here isn't merely a no-op, it fails. The persist steps have already written the new config, which refers to the new variable. Caddy's Caddyfile carries the Cloudflare token as `{env.CLOUDFLARE_API_TOKEN}`; the *running* server resolves that against its own environment, gets an empty string, and rejects the whole config:

```
provision dns.providers.cloudflare: API token '' appears invalid;
ensure it's correctly entered and not wrapped in braces nor quotes
```

Caddy keeps serving its previous config (reload is atomic), but the save surfaces `APP_RELOAD_FAILED` for what was only ever a restart. The restart applies new env and new mount contents together — the only order that works.

`execCommandInContainer` is a general-purpose non-interactive exec utility (`containerManagerExec.js`) — exposed on the containerManager facade for any caller, not specific to app reload.

## Adding a New App

1. **Backend module** — Create `backend/src/lib/containerApps/<app>.js` exporting `{ getDefaultAppConfig, validateAppConfig, generateDerivedConfig, maskSecrets, getReloadCommand }` as a named module object. Add `getPublishedLinks` too if the app exposes a URL a human would open, and `getSecretMountNames` if any generated file mount holds a secret (passwords, keys, tokens, hashes) — otherwise its content is readable by any read-scoped token.
2. **Register backend** — Add entry to `APP_REGISTRY` in `containerApps/appRegistry.js`.
3. **Frontend component** — Create `frontend/src/apps/<app>/<AppName>Section.jsx` using SectionCard.
4. **Register frontend** — Add entry to `APP_REGISTRY` in `frontend/src/apps/appRegistry.js`.
5. **Update docs** — Add the app's `appConfig` schema and behavior to this file.

## Eject

Eject converts an app container to a generic container. The `app` and `appConfig` fields are removed; generated env vars and mounts become directly editable. The mounts the app declared secret (`getSecretMountNames`) are first given a stored `secret: true` (row update, no restart), so their content stays write-only once the module no longer speaks for them. This is a one-way operation.

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
  "cloudflareDnsEnabled": true,
  "cloudflareApiToken": "cf-token"
}
```

- `domain` — Base domain for wildcard certificate (e.g. `example.com`)
- `hosts[]` — Reverse proxy entries. `subdomain` is a DNS label; `target` is IP/hostname with optional port (also accepts `scheme://host[:port][/path]`). The Caddyfile is generated with `target` interpolated into a `reverse_proxy` directive, so the validator rejects `\n` / `\r` / `{` / `}` and any shape that doesn't match `host[:port]` or `scheme://host[:port][/path]`. Returns **422 INVALID_APP_CONFIG** otherwise.
- `cloudflareDnsEnabled` — The user's assertion that the container image ships the `caddy-dns/cloudflare` module. Caddy's DNS providers are compile-time Go plugins (`xcaddy build --with github.com/caddy-dns/cloudflare`); the stock `caddy:latest` image does **not** include it, and a Caddyfile referencing `dns cloudflare` makes that image fail to start with an unknown-module error. No `dns cloudflare` / `acme_dns cloudflare` directives are emitted unless this is `true` **and** a token is set, so the default image stays usable for plain local proxying. In the UI this is a toggle that reveals the token field. Absent means "unchanged"; configs stored before this field existed are read as enabled when a token is set (the old shape's only way to express the intent).
- `cloudflareApiToken` — Cloudflare API token for DNS-01 challenge. Stored as secret, masked in API responses as `{ isSet: boolean }`. Omit it (or send the `{ isSet }` mask back) to keep the stored token; send an explicit `""` to clear it. Kept in storage (but inert) while `cloudflareDnsEnabled` is `false`, so toggling off and back on doesn't require re-entering it.

### Derived Config

- **env:** `CLOUDFLARE_API_TOKEN` (secret) when Cloudflare DNS is enabled and a token is set
- **mounts:** `Caddyfile` (file → `/etc/caddy/Caddyfile`, readonly), `caddy-data` (dir → `/data`), `caddy-config` (dir → `/config`) — no secret files (the Cloudflare token reaches Caddy as an env var, referenced as `{env.CLOUDFLARE_API_TOKEN}`), so the Caddyfile is readable
- **Caddyfile:** Generated with wildcard site block, per-host reverse proxy handlers, Cloudflare DNS TLS block (when Cloudflare DNS is enabled and a token is set), and a global log filter that routes `http.handlers.reverse_proxy` logs to a separate logger capped at `ERROR` (suppresses the per-disconnect `aborting with incomplete response` WARN that SSE-heavy apps like Wisp trigger on every client refresh or navigation)
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
  ],
  "externalUrl": "https://registry.example.com",
  "oidc": {
    "enabled": true,
    "name": "Pocket ID",
    "issuer": "https://id.example.com",
    "clientId": "zot-registry",
    "clientSecret": "s3cr3t",
    "scopes": ["openid", "profile", "email"],
    "usernameClaim": "preferred_username"
  },
  "sessionKeys": { "hashKey": "…", "encryptKey": "…" }
}
```

- `users[]` — htpasswd authentication entries. Passwords are hashed with SHA-512 crypt on save; only hashes are stored in `appConfig`. Masked in API responses as `{ username, hasPassword }`. zot's own docs claim bcrypt-only, but `pkg/api/htpasswd.go` sniffs the prefix and accepts `$2a$`/`$2b$`/`$2y$`, `$5$` and `$6$`.
- `externalUrl` — the address browsers reach the registry on. **Required when `oidc.enabled`:** zot builds the OIDC `redirect_uri` from it, and with it unset falls back to `http.address:port` (`0.0.0.0:5000`), which no browser can be redirected to.
- `oidc` — OpenID Connect sign-on for the registry's web UI. `clientSecret` is masked in API responses as `{ isSet: boolean }`. `usernameClaim` picks the ID-token claim that becomes the user's identity; defaults to `preferred_username` (zot's own default is `email`).
- `sessionKeys` — session cookie HMAC + AES keys, minted on first enable and **never returned by the API**. zot invents random keys when the file is absent, dropping every browser session on each restart — and Wisp restarts zot on every config save. Cleared when OIDC is disabled, so re-enabling mints fresh keys.

When adding or updating a user, send `{ username, password }` — the backend hashes the password and stores only the hash. To keep an existing password, omit the `password` field; the backend recovers the stored hash **by username**, so a *renamed* user reads as new and must supply a password. A `hash` sent by a client is ignored — hashes only ever come from the stored config. Same contract for `oidc.clientSecret`: omit it (or send back the `{ isSet }` mask) to keep the stored value.

#### Identity model — htpasswd vs OIDC

zot has **no user table**. Both paths resolve a login to a bare *identity string*, and that string is the only thing tying together an access-control policy, an API key, and a session:

| Path | Identity is | Used by |
|------|-------------|---------|
| htpasswd | the username in the file | basic auth — `docker login`, `skopeo`, the UI's password form |
| OIDC | the value of `usernameClaim` from the ID token | browser redirect flow only |

They are the same user **iff the strings are equal** — which is what `usernameClaim` is for. There is nothing to "migrate": no account record exists to move.

> **The IdP is a hard startup dependency.** `authn.go`'s `tryAuthnHandlers` builds the relying party *before* it returns the middleware closure, and `NewRelyingPartyOIDC` performs OIDC discovery against `<issuer>/.well-known/openid-configuration`, then `log.Panic()`s if it fails. So:
> - IdP goes down **while zot is running** → htpasswd basic auth is unaffected (a separate path in `basicAuthn`). The fallback works.
> - IdP is unreachable **when zot starts** → zot exits. The whole registry is down, not just SSO — htpasswd cannot save you.
>
> This matters because Wisp restarts the container on every appConfig save (`getReloadCommand()` returns `null`), and on host boot via autostart. If the IdP is another container on the same host, mind the ordering.

`docker login` cannot follow an OIDC redirect, so an SSO-only identity needs an **API key** (`zak_…`, minted in the web UI, used as the basic-auth password). Wisp therefore sets `http.auth.apikey: true` whenever OIDC is on — zot does *not* enable it implicitly (`basicAuthn` checks `IsAPIKeyEnabled()` independently, contrary to a note in zot's `examples/README.md`), and API keys live in MetaDB, which the always-on `extensions.search` provides.

The redirect URI to register with the provider is `<externalUrl>/zot/auth/callback/oidc`. The provider key must literally be `oidc` — zot's `openIDSupportedProviders` is `["google", "gitlab", "oidc"]`, and `oidc` is the generic one.

### Derived Config

- **env:** (none)
- **mounts:** `config-json` (file → `/etc/zot/config.json`, readonly), `registry` (dir → `/var/lib/registry`), optionally `htpasswd` (file → `/etc/zot/htpasswd`, readonly) when users are configured, optionally `session-keys` (file → `/etc/zot/session-keys.json`, readonly) when OIDC is enabled
- **Secret mounts** (`getSecretMountNames`): `htpasswd` and `session-keys` always; `config-json` while OIDC is enabled (it then carries `clientsecret`). Without OIDC `config.json` is readable.
- **config.json:** Generated zot config with storage and HTTP settings. `http.auth.htpasswd` when users exist; `http.auth.openid.providers.oidc` + `http.auth.apikey` + `http.auth.sessionKeysFile` when OIDC is enabled; `http.externalUrl` when set. Provider keys are lowercase-concatenated (`clientid`, `clientsecret`, `claimmapping`) because zot reads its config through viper/mapstructure. Whenever any auth is on, `http.accessControl` grants anonymous `read` and every authenticated identity `read,create,update,delete`.
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
- `server.iconModel` — Apple SMB extensions toggle. `"TimeCapsule6,106"` (default) enables `vfs_fruit` + `streams_xattr` for nicer macOS Finder behaviour and Time Capsule icon; `"-"` disables AAPL extensions entirely. Shares whose backing filesystem has no extended attributes (exFAT, vfat, some CIFS sources) are handled by tiny-samba itself: it probes each share path on start/reload and drops `fruit`/`streams_xattr`, `store dos attributes` and `ea support` for that share only (settled 2026-10-13 — auto-detect over a per-share Wisp toggle, since the user rarely knows the backing filesystem and a share's source can change; always-off was rejected because it costs macOS clients on xattr-capable disks `._` clutter and slower Finder browsing).
- `users[].name` — lowercase, starts with a letter, only `[a-z0-9._-]`. `users[].password` accepts plaintext or `$NT$<32 hex>`. Stored as-is in `appConfig` (no hashing — tiny-samba's `pdbedit` accepts both forms). Masked in API responses as `{ name, password: { isSet: bool } }`. PATCH bodies that omit `password` for an existing user keep the prior value (merged forward by `validateAppConfig(new, old)`).
- `shares[].name` — lowercase DNS label (`[a-z0-9-]`); SMB share name visible to clients. The in-container mount path is fixed at `/shares/<name>` by convention (no user-visible field — it's an implementation detail). Each share fans out to its own wisp directory mount (named `share-<name>`).
- `shares[].previousName` — **write-only, per save.** The name an existing share had when the form loaded it; the UI sends it on every share that was already saved, new rows omit it. `getMountRenames` turns `previousName ≠ name` into a mount rename (`share-<old>` → `share-<new>`), so a Local share's files move with it. Must name a current share, at most one row per old name (**422** `INVALID_APP_CONFIG`); never persisted. A saved share that no row claims (and whose name no row reuses) is a **removal**: a Local share's `files/share-<name>` is deleted once the save stands, a Storage-backed share's data is never touched. Renaming onto a name held by another current share, or onto a `files/share-<name>` left on disk, is refused — remove/rename in a separate save. (Settled 2026-10-16: `previousName` over a persisted share id — stateless, nothing to backfill for existing containers.)
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
- **passwords.yaml:** `name: password` map (passwords double-quoted; plaintext or `$NT$` hash passes through). Declared secret (`getSecretMountNames` → `tiny-samba-passwords`); `config.yaml` holds no secret and is readable.
- **UI:** removing a saved Local share from the form only stages it; **Save** then opens a `ConfirmDialog` ("Delete share data?") naming every Local share whose files the save deletes, with **Delete and save** / **Cancel**. Renames and Storage-backed removals save without a prompt.
- **Reload:** `tiny-samba reload` — applies live for users, passwords, shares, access, min protocol. Server-level changes (`workgroup`, `netbiosName`, `dataUid`) flip `requiresRestartForChange` and the badge stays until restart.
