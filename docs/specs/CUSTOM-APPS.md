# Custom App Containers

Custom App Containers are containers created from hardcoded app templates that provide dedicated configuration UIs instead of generic env vars and mounts sections. Each app has a backend module (validates config, generates derived files) and a frontend that gives the container page the app's groups.

App orchestration is a consumer of containerManager, which has zero knowledge of apps: it persists arbitrary `metadata` verbatim and exposes the primitives the app flows are composed from.

## Overview

- User picks an app template (or "Generic Container") when creating a container
- The app's module validates the choice and computes the derived env/mounts/devices/files, which are written through containerManager
- App identity lives in `container.json.metadata.app` (string id) and `container.json.metadata.appConfig` (object)
- The frontend shows the app's own groups, first on the page, instead of Environment and Storage when `config.metadata?.app` is set ([UI-CONTAINER.md](UI-CONTAINER.md), App containers)
- Users can "eject" an app container to a generic container — clears `metadata.app`/`metadata.appConfig`, leaves env/mounts/devices/files in place

## Data Model

`container.json` carries an opaque `metadata` field that containerManager persists but never introspects. The app's identity is written into it:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `metadata.app` | string \| omitted | omitted | App registry ID (e.g. `"caddy-reverse-proxy"`). Immutable after create except via eject. |
| `metadata.appConfig` | object \| omitted | omitted | Structured config for the app. Shape is app-specific. Only present when `metadata.app` is set. Source of truth — env/mounts/files are derived from it. |
| `pendingRestart` | `{ since }` \| omitted | omitted | Top-level field (see [CONTAINERS.md → Config changes that need a restart](CONTAINERS.md#config-changes-that-need-a-restart)). Set when an `appConfig` change can't be applied via live reload while the container is running, or when generic config changes (mounts, env, network) require a restart. Dropped once the task is seen to have started after `since`. |

## App Registry

Each app has a registry entry: a label, a description, a default image, and whether a custom image is allowed (the create form prefills the image, editable when it is). An app id matches the registry's own keys only, so an id like `constructor` is unknown.

- **`requiresRoot: true`** — the container is created with `runAsRoot: true`. For apps that need UID 0 inside the container: binding privileged ports, calling `setuid` per session, or writing to root-owned dirs in the image.
- **A new registry entry defaults to non-root**: `requiresRoot` is set only for a concrete, identified need — a privileged port bound without capability tricks, startup writes to root-owned paths *inside the image rootfs* (not mount points), or capabilities effectively tied to UID 0. "The upstream image's `USER` defaults to 0" is not a reason.
- **`defaultServices: [{ port, type, txt }]`** — seeds `container.services[]` at create time, so the app's mDNS records publish out of the box (e.g. `_smb._tcp` for tiny-samba, `_https._tcp` for Caddy). After create the user owns the services list: a save does not re-seed it.

## Backend App Module Interface

What an app's module provides, and the rule each part carries:

- **A default `appConfig`** for a new container (`getDefaultAppConfig(context?) → appConfig`, `context` being `{ containerName }`). It may derive from the container's name (tiny-samba's `server.netbiosName`).
- **Validation** (`validateAppConfig(appConfig, oldAppConfig) → appConfig`; `oldAppConfig` is `null` on create), which normalizes and throws `INVALID_APP_CONFIG`. **Any module with a secret must merge it forward from the stored config**: secrets are masked on output, so a form that doesn't retype one omits it. Never trust a secret (or a password hash) that arrives from the client when the stored config already has one.
- **The derived config** (`generateDerivedConfig(appConfig)`, shape below): the env, mounts and file-mount contents, which replace the container's on every save, and devices, when the app derives them. It may return a transformed `appConfig` (zot stores hashed passwords back into it).
- **Mount renames** (`getMountRenames(newAppConfig, oldAppConfig) → { oldMountName: newMountName }`, optional): the mounts the app means to rename in this save. It is given the raw incoming appConfig, after validation. Needed by any app whose derived mount names come from user-editable fields: without it a rename reads as "drop the old mount, add a new one" and the old mount's data is deleted. With it, Local data moves to the new name.
- **Masked secrets** (`maskSecrets(appConfig) → appConfig`) for API responses.
- **Secret file mounts** (`getSecretMountNames(appConfig) → string[]`, optional; pure and synchronous, because it runs on every detail read): the file mounts whose generated content is a secret. **An app that writes a secret into a file mount must list it**; listed files are write-only on every surface (see [Mount content routes](#mount-content-routes)) and written `0600` on the host.
- **A reload command** (`getReloadCommand() → string[] | null`, optional), run inside the running container to apply a new config; `null` when the app has no live reload. Without one, a save on a running container needs a restart.
- **`requiresRestartForChange(oldAppConfig, newAppConfig) → boolean`** (optional): true when the change includes fields the app's reload can't apply live (e.g. tiny-samba's `server.workgroup`). The save then sets `pendingRestart` and reports `requiresRestart: true` even after a successful reload.
- **`agentWritableAppConfigFields`** (optional): the top-level appConfig keys the MCP `update_app_config` tool may change (see [MCP.md](MCP.md)). Absent or empty = the app is not agent-configurable. Never list secrets, certificate identity, or auth settings. The UI/REST surface is unaffected.
- **The host's certificate** (optional): an app that serves HTTPS with the certificate Wisp holds ([CERTIFICATES.md](CERTIFICATES.md)) says so. Its derived config and its published links are then given that certificate, or nothing when Wisp holds none, and Wisp runs the app's save whenever the certificate changes ([CERTIFICATES.md → Delivery](CERTIFICATES.md#delivery)). The certificate is never part of `appConfig`.
- **Published links** (`getPublishedLinks`, optional), below.

### generateDerivedConfig return shape

```js
{
  env: { KEY: { value: string, secret?: boolean } },        // replaces config.env entirely
  mounts: [{ type, name, containerPath, readonly }],         // replaces config.mounts entirely
  mountContents: { mountName: 'file content string' },       // written to files/<mountName>
  devices: [...],                                            // optional: replaces config.devices when present
  appConfig: {...},                                          // optional: a transformed appConfig to store
}
```

### getPublishedLinks

The URLs an app makes reachable, as `[{ url, target?, label? }]`, for the Home page launcher (see [UI-HOST.md § Tab: Home](UI-HOST.md#tab-home)). The Home page asks **every** container carrying `metadata.app`; no container name is ever hardcoded, so zero, one, or many instances of an app all work. Return only what the config *proves* exists — an empty array when the relevant fields are unset — and never throw.

- **`url`** — absolute `http`/`https`. It is canonicalized (host lowercased, default port and bare trailing slash dropped) and becomes the tile's id.
- **`target`** — set it when the URL fronts *something else*, and carry through whatever the config holds (`host`, `host:port`, or `scheme://host[:port][/path]`). The Home page resolves it against workload hostnames to give the tile live state, and renders a stateless external tile when it resolves to nothing. **Omit `target` when the URL is the container's own address** — the tile then joins to the publishing container itself.
- **`label`** — optional display name. Omit it to let the tile name itself from the workload it points at (or the URL's first hostname label).

Implemented by: **caddy-reverse-proxy** (one link per `hosts[]` entry → `https://<subdomain>.<domain>`, the domain that of the certificate Wisp holds, `target` carried; none while Wisp holds no certificate), **jellyfin** (`publishedUrl`, no target), **zot-registry** (`externalUrl`, no target). **tiny-samba** publishes no HTTP surface.

## API Changes

### POST /api/containers — Create

Body gains optional fields: `app` (string, validated against registry) and `appConfig` (object). If `app` is provided without `appConfig`, the app's default is used. On any failure after create, the container is rolled back. The create job's result is `{ name }`.

### PATCH /api/containers/:name — Update

- `{ appConfig }`, **alone** → the app config save, under the container's lock: validates via the app module, regenerates the derived config, persists the new `metadata.appConfig` + `env`/`mounts`/`devices`, writes mount file contents, attempts live reload if running. `appConfig` with any other key (`devices` included) → **400** `VALIDATION_FAILED` naming the other keys (settled 2026-11-20); on a generic container → **422** `CONFIG_ERROR`.
- `{ envPatch }` / `{ env }` / `{ mounts }` on an app container → rejected with `APP_CONFIG_ONLY` (422), before anything is written. `{ devices }` on its own is accepted — the Devices section is shown on every container — but an app module that derives devices (Jellyfin's GPU toggle) replaces them on its next `appConfig` save.
- `eject` → **400** `VALIDATION_FAILED`: eject is its own command (below).
- Anything else → the generic configuration update.

### POST /api/containers/:name/eject — Eject

Its own command, under the container's lock (settled 2026-11-20). Eject converts an app container to a generic container: `metadata.app` and `metadata.appConfig` are removed; env, mounts, devices and files are all preserved and become directly editable. The mounts the app declared secret are first given a stored `secret: true` (no restart), so their content stays write-only once the module no longer speaks for them. This is a one-way operation. A generic container is left as it is.

### Mount content routes

An app container's mounts belong to its app module: every save writes the whole `mounts` list and regenerates the file contents from `appConfig`. Two separate rules, both for every caller (settled 2026-10-16):

- **Writes are refused.** `PUT …/content`, `POST …/file`, `POST …/zip`, `POST …/init`, `DELETE …/data`, and row `PATCH` / `DELETE /mounts/:mountName` on a mount of a container whose `metadata.app` resolves to a registered module → `APP_CONFIG_ONLY` (422), as is every `POST /mounts` on such a container: the next app save would drop a hand-added mount and delete its data (settled 2026-11-12). An unregistered `metadata.app` owns no mounts (the UI shows the generic Mounts section for it too).
- **Reads follow the secret rule.** `GET …/content` is refused (403 `CONTAINER_MOUNT_SECRET`) for a secret file mount — a stored `secret: true`, **or** a name the app module declares secret — and allowed otherwise, so non-secret app files (Caddy's `Caddyfile`, tiny-samba's `config.yaml`, zot's `config.json` without OIDC) are readable. The app's declaration is read from the stored appConfig on every request: app containers carry no stored flag. Container detail and MCP `get_container` mark the same mounts `secret: true` with `isSet` / `sizeBytes` ([CONTAINERS.md § Secret file mounts](CONTAINERS.md#secret-file-mounts)).

### Error Codes

`INVALID_APP_CONFIG`, `APP_CONFIG_ONLY`, `UNKNOWN_APP_TYPE` and `APP_RELOAD_FAILED`, all 422: [ERROR-HANDLING.md](ERROR-HANDLING.md).

## Frontend

### App group contract

Each app's frontend gives the page its groups: values as text, lists with a form per
row, switches. It receives the container's config (secrets masked in `appConfig`) and a
way to save. Every save sends the whole `appConfig`, read from the record at the moment
of the save, with the one row or group changed; an unchanged secret is sent back the
keep-stored way.

## Live Reload

What an `appConfig` save does on a running container. The save's result is `{ requiresRestart, reloaded? }`: MCP's `update_app_config` returns it. On a container that is not running there is no reload and no flag, and the result is `{ requiresRestart: false }`.

- **The app's reload command is run** inside the container when the app has one. Apps without one always set `pendingRestart` instead.
- **Accepted** (exit 0): the result is `{ requiresRestart, reloaded: true }`. `requiresRestart` is true when the app's `requiresRestartForChange` says so, or the mount layout changed, or the persist flagged a restart because the normalized mounts or devices changed (an unchanged save flags nothing, settled 2026-11-12).
- **Refused** (non-zero exit): the save is **rolled back** — the persisted config (metadata/env/mounts/devices) and the mount file contents return to what they were, renames are reversed (data moves back), mounts only the rejected config had lose the backing stores this save created, and the restart-required flag is restored exactly as it was before the save (settled 2026-11-12) — then `APP_RELOAD_FAILED` (422). The app kept serving its previous config, so the rollback keeps the disk in step with what runs. The detail keeps the output's lines that look like errors, and otherwise its **tail**. If the rollback itself fails, the error detail says so and the persisted config may not match the running app.
- **The exec itself fails** for a non-app reason (e.g. command not found): `pendingRestart` is set and the result is `{ requiresRestart: true }` — no rollback; the app never judged the config.
- **Mount layout is not reloadable.** Live reload covers *file contents* but not *bind mount layout*: when the mounts' type, name, container path, read-only flag, source, sub-path or tmpfs size differ, `pendingRestart` is set even if the reload command returned exit 0.
- **Env vars never reload.** A running process keeps the environment it was started with, so on any env difference (name + value; the `secret` flag is presentation-only) the reload is **skipped entirely** and `pendingRestart` is set. A reload there would fail, not just do nothing: the new files refer to env the running process lacks (Caddy rejects its config, `APP_RELOAD_FAILED`).
- **A dropped mount's data is deleted only once the config that dropped it stands** (settled 2026-10-16): every outcome that keeps the new config deletes it, and the `APP_RELOAD_FAILED` rollback does not, so a rejected save never costs data.

---

## App: Caddy Reverse Proxy

**ID:** `caddy-reverse-proxy`
**Default image:** `caddy:latest` (custom image allowed)

The app serves its sites over HTTPS with the host's certificate
([CERTIFICATES.md](CERTIFICATES.md)): Wisp gets and renews it, Caddy only loads it, so
the stock image is enough. The app has no domain, token or certificate setting of its
own, and never asks a certificate authority for anything.

### appConfig Schema

```json
{
  "hosts": [
    { "subdomain": "ha", "target": "192.168.1.100" },
    { "subdomain": "plex", "target": "192.168.1.101:32400" }
  ]
}
```

- `hosts[]` — Reverse proxy entries, one site each: `https://<subdomain>.<domain>`, the domain that of the certificate Wisp holds. `subdomain` is a DNS label; `target` is IP/hostname with optional port (also accepts `scheme://host[:port][/path]`). The Caddyfile is generated with `target` interpolated into a `reverse_proxy` directive, so the validator rejects `\n` / `\r` / `{` / `}` and any shape that doesn't match `host[:port]` or `scheme://host[:port][/path]`. Returns **422 INVALID_APP_CONFIG** otherwise.
- There are no secrets in `appConfig`.
- **Sites are stored whether or not Wisp holds a certificate.** While it holds none, the app serves no site, and its page says where the certificate is set up.

### Derived Config

- **env:** (none)
- **mounts:** `Caddyfile` (file → `/etc/caddy/Caddyfile`, readonly), `tls-cert` (file → `/etc/caddy/tls/fullchain.pem`, readonly), `tls-key` (file → `/etc/caddy/tls/key.pem`, readonly), `caddy-data` (dir → `/data`), `caddy-config` (dir → `/config`). The two `tls-` files are always mounted, empty while Wisp holds no certificate, so a certificate's arrival changes file contents and never the mount layout.
- **Secret mounts** (`getSecretMountNames`): `tls-key`. The Caddyfile and `tls-cert` are readable.
- **Caddyfile:** with a certificate, one wildcard site `*.<domain>` that loads the two `tls-` files, a reverse proxy handler per host and a 404 for any other name; without one, no site. Always: the reverse proxy's own logs capped at `ERROR` (a disconnecting SSE client is otherwise a WARN each time).
- **Reload:** a `caddy reload` that makes Caddy read the certificate files again even when the Caddyfile has not changed: a renewal changes only the files.

### Containers made before the host's certificate

Such a container held its own `domain`, `email`, `cloudflareDnsEnabled` and
`cloudflareApiToken`, and got its certificate itself, which needed an image with the
`caddy-dns/cloudflare` module.

- **At the update**, a state migration
  ([UPDATES.md → Shipped migrations](UPDATES.md#shipped-migrations)) moves the domain and
  the token to the [certificate setting](CERTIFICATES.md#the-certificate-setting) and
  removes the four fields. Its env, mounts, Caddyfile and image are left as they were,
  so it keeps serving with its own certificate, across a restart too.
- **At Wisp's first delivery** to it, its env, mounts and Caddyfile are rewritten, and
  it is flagged restart required (its env and mount layout change).
- **After that one restart**, at a time the user chooses, it serves Wisp's certificate.
  Wisp never changes its image: the one it has serves Wisp's certificate as well, and
  the user moves it to the stock image with the Image group's **Use the app's image**
  ([UI-CONTAINER.md](UI-CONTAINER.md#groups)).

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

- `users[]` — htpasswd authentication entries. Passwords are hashed with SHA-512 crypt on save (zot accepts `$6$` hashes, though its docs say bcrypt only); only hashes are stored in `appConfig`. Masked in API responses as `{ username, hasPassword }`.
- `externalUrl` — the address browsers reach the registry on. **Required when `oidc.enabled`:** zot builds the OIDC `redirect_uri` from it.
- `oidc` — OpenID Connect sign-on for the registry's web UI. `clientSecret` is masked in API responses as `{ isSet: boolean }`. `usernameClaim` picks the ID-token claim that becomes the user's identity; defaults to `preferred_username` (zot's own default is `email`).
- `sessionKeys` — session cookie HMAC + AES keys, minted on first enable and **never returned by the API**, so browser sessions survive a restart (Wisp restarts zot on every config save). Cleared when OIDC is disabled, so re-enabling mints fresh keys.

When adding or updating a user, send `{ username, password }` — the backend hashes the password and stores only the hash. To keep an existing password, omit the `password` field; the backend recovers the stored hash **by username**, so a *renamed* user reads as new and must supply a password. A `hash` sent by a client is ignored — hashes only ever come from the stored config. Same contract for `oidc.clientSecret`: omit it (or send back the `{ isSet }` mask) to keep the stored value.

#### Identity model — htpasswd vs OIDC

zot has **no user table**. Both paths resolve a login to a bare *identity string*, and that string is the only thing tying together an access-control policy, an API key, and a session:

| Path | Identity is | Used by |
|------|-------------|---------|
| htpasswd | the username in the file | basic auth — `docker login`, `skopeo`, the UI's password form |
| OIDC | the value of `usernameClaim` from the ID token | browser redirect flow only |

They are the same user **iff the strings are equal** — which is what `usernameClaim` is for. There is nothing to "migrate": no account record exists to move.

**The IdP is a hard startup dependency.** With the IdP unreachable when zot starts, zot exits: the whole registry is down, not just SSO, and htpasswd cannot help. An IdP that goes down while zot is running leaves htpasswd basic auth working. Wisp restarts the container on every appConfig save, and on host boot via autostart: if the IdP is another container on the same host, mind the ordering.

`docker login` cannot follow an OIDC redirect, so an SSO-only identity needs an **API key** (`zak_…`, minted in the web UI, used as the basic-auth password). Wisp therefore sets `http.auth.apikey: true` whenever OIDC is on: zot does not enable it by itself. `extensions.search` is always on, because API keys live in the MetaDB it provides.

The redirect URI to register with the provider is `<externalUrl>/zot/auth/callback/oidc`. The provider key is `oidc`, zot's generic one.

### Derived Config

- **env:** (none)
- **mounts:** `config-json` (file → `/etc/zot/config.json`, readonly), `registry` (dir → `/var/lib/registry`), optionally `htpasswd` (file → `/etc/zot/htpasswd`, readonly) when users are configured, optionally `session-keys` (file → `/etc/zot/session-keys.json`, readonly) when OIDC is enabled
- **Secret mounts** (`getSecretMountNames`): `htpasswd` and `session-keys` always; `config-json` while OIDC is enabled (it then carries `clientsecret`). Without OIDC `config.json` is readable.
- **config.json:** Generated zot config with storage and HTTP settings. `http.auth.htpasswd` when users exist; `http.auth.openid.providers.oidc` + `http.auth.apikey` + `http.auth.sessionKeysFile` when OIDC is enabled; `http.externalUrl` when set. Provider keys are lowercase-concatenated (`clientid`, `clientsecret`, `claimmapping`), the form zot reads. Whenever any auth is on, `http.accessControl` grants anonymous `read` and every authenticated identity `read,create,update,delete`.
- **Reload:** Not supported — config changes require container restart

---

## App: Jellyfin

**ID:** `jellyfin`
**Default image:** `jellyfin/jellyfin:latest` (custom image allowed)
**Registry flags:** none. It does not run as root: its Local folders are owned by the container's user, and the GPU comes through the container's devices ([CONTAINERS.md](CONTAINERS.md#devices-entry)). No service is seeded: Jellyfin announces itself by its own discovery.

### appConfig Schema

```json
{
  "libraries": [
    { "label": "movies", "sourceId": "<storage mount id>", "subPath": "films" }
  ],
  "gpuEnabled": false,
  "publishedUrl": "http://<container>.local:8096"
}
```

- `libraries[]` — the media folders. `label` is the folder's name under `/media`: one path segment, no leading dot, unique, and not `config` or `cache`. `sourceId` names a configured storage mount ([STORAGE.md](STORAGE.md)); one that names none is refused. `subPath` is an optional folder inside it, relative, with no `..`.
- `gpuEnabled` — share the host's GPU with the container. Wisp picks the first supported one (Intel or AMD); with none on the host the save is refused. Hardware acceleration itself is turned on in Jellyfin's own admin pages. On a host with several GPUs, choosing one means ejecting the app and editing the container's devices.
- `publishedUrl` — the address Jellyfin gives its clients, and the app's link on the Home page. A new container starts with `http://<container>.local:8096`.
- There are no secrets. Every refusal above is 422 `INVALID_APP_CONFIG`.

### Derived Config

- **Mounts:** `config` → `/config` and `cache` → `/cache`, folders kept with the container; each library → `/media/<label>`, from its storage mount and sub-path. All writable.
- **Env:** `JELLYFIN_PublishedServerUrl`, when `publishedUrl` is set.
- **Devices:** the GPU when `gpuEnabled`, none otherwise: each save replaces the container's devices.
- **No live reload:** a change to the libraries, the GPU or the published address needs a restart.

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
- `server.iconModel` — Apple SMB extensions toggle. `"TimeCapsule6,106"` (default) enables `vfs_fruit` + `streams_xattr` for nicer macOS Finder behaviour and Time Capsule icon; `"-"` disables AAPL extensions entirely. Shares whose backing filesystem has no extended attributes (exFAT, vfat, some CIFS sources) are handled by tiny-samba itself: it probes each share path on start/reload and drops `fruit`/`streams_xattr`, `store dos attributes` and `ea support` for that share only (settled 2026-10-13: detected per share, not a Wisp toggle).
- `users[].name` — lowercase, starts with a letter, only `[a-z0-9._-]`. `users[].password` accepts plaintext or `$NT$<32 hex>`. Stored as-is in `appConfig` (no hashing: tiny-samba accepts both forms). Masked in API responses as `{ name, password: { isSet: bool } }`. PATCH bodies that omit `password` for an existing user keep the prior value.
- `shares[].name` — lowercase DNS label (`[a-z0-9-]`); SMB share name visible to clients. The in-container mount path is fixed at `/shares/<name>`. Each share fans out to its own wisp directory mount (named `share-<name>`).
- `shares[].previousName` — **write-only, per save.** The name an existing share had when the form loaded it; the UI sends it on every share that was already saved, new rows omit it. `getMountRenames` turns `previousName ≠ name` into a mount rename (`share-<old>` → `share-<new>`), so a Local share's files move with it. Must name a current share, at most one row per old name (**422** `INVALID_APP_CONFIG`); never persisted. A saved share that no row claims (and whose name no row reuses) is a **removal**: a Local share's `files/share-<name>` is deleted once the save stands, a Storage-backed share's data is never touched. A saved Local share whose claiming row now has a `source` — switched to a storage mount, renamed or not — counts as a removal of its local data too: its `files/share-<old name>` is deleted once the save stands, nothing is moved onto the storage mount — unless a Local share in the same save takes over the old name, which then keeps and serves the directory (settled 2026-11-12). Renaming onto a name held by another current share, or onto a `files/share-<name>` left on disk, is refused — remove/rename in a separate save. (`previousName`, not a persisted share id: settled 2026-10-16.)
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
- **UI:** removing a saved Local share asks first ("Delete share data?"), naming the share; so does saving a share's form when the edit switches it to a storage mount. A Local → Local rename and the removal of a storage-backed share do not ask (settled 2026-11-21).
- **Reload:** `tiny-samba reload` — applies live for users, passwords, shares, access, min protocol. Server-level changes (`workgroup`, `netbiosName`, `dataUid`) flip `requiresRestartForChange` and the badge stays until restart.
