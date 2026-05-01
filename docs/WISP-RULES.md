# Wisp Rules

Project-specific conventions that apply the general principles from [CODING-RULES.md](CODING-RULES.md) to the Wisp codebase.

---

## Deployability

Wisp is a **deployable application**. When fixing or changing behaviour, do it in the app (functionality or setup scripts) so that future installs work correctly. Prefer improving the install/setup pipeline over documenting manual server steps. Manual server fixes are for debugging or testing only; the final resolution should live in the codebase.

---

## Stack

- **Backend:** Node.js, Fastify, dbus-next (libvirt DBus API)
- **Frontend:** React (Vite), Tailwind CSS
- **Data:** libvirt domain XML, `config/wisp-config.json`, per-VM directories under `vmsPath` (from config)

## Naming (applied)

- Functions named for their VM operation: `startVM(name)`, `stopVM(name)`, `attachISO(vmName, slot, isoPath)` — not `callDomainMethod('UpdateDevice', ...)`.
- File/module names reflect domain: `vmManagerConfig.js`, `diskOps.js`, `cloudInit.js`, `paths.js`.
- Frontend: `doAction` -> `executeDiskOperation`, `update` -> `updateField`.
- **UI sections and files:** Keep component and file names aligned with user-visible tab/section names. When renaming a tab or section (e.g. "OS Settings" → "Host Mgmt"), rename the corresponding file and default export (e.g. `HostOSSettings.jsx` → `HostMgmt.jsx`). Section blocks with a clear label use a matching component name (e.g. `HostStorage.jsx` for **Storage**, `HostBackup.jsx` for **Backup** in Host Mgmt).

## No Code Duplication (applied)

- Shared components: `SectionCard`, `Toggle`, `ConfirmDialog`, `vmIcons.jsx`, `StatPill`.
- Overview and Create VM share section components (`GeneralSection`, `AdvancedSection`, `DisksSection`, `CloudInitSection`) via an `isCreating` prop.
- Backend shared utilities: `ensureImageDir` (paths.js), `createAppError` (routeErrors.js), `streamDownloadToFile` / `uniqueFilename` (downloadFromUrl.js), constants in `libvirtConstants.js`.

## Dependencies (applied)

- Optional `config/runtime.env`: parsed by backend/frontend when present; no `dotenv` package.
- Use `@xterm/xterm` and `@xterm/addon-fit` (not deprecated `xterm` / `xterm-addon-fit`).
- Fonts: `font-family: system-ui, -apple-system, sans-serif` for body UI; Tailwind `font-mono` / system monospace stack only for code-like content (no webfonts, no CDN).
- No cdn, jsdelivr, unpkg, or googleapis links in frontend code.
- noVNC vendored locally via `scripts/vendor-novnc.sh`.
- `npm ci` for reproducible installs; include `package-lock.json` in deploys.
- `npm install --omit=optional` to skip deprecated optional transitive deps.

## XML Parsing (applied)

- Use `fast-xml-parser` exclusively. Helper functions: `parseDomainRaw`, `parseVMFromXML`, `buildXml`, `buildDiskXml`.
- When modifying CDROM/disk XML, extract the existing device element from the domain XML and modify its `<source>` — do not construct XML from scratch.
- `<clock>` is a top-level element in libvirt domain XML, not nested inside `<features>`.

## Error Handling (applied)

- vmManager throws `{ code, message, raw? }`.
- Route handlers map codes to HTTP status: 404, 409, 422, 500, 503.
- Routes return `{ error: string, detail: string }` on failure. `detail` is `err.raw || err.message`.
- Long-lived SSE streams may emit `{ error, detail, code? }`. Job progress streams use `{ step: "error", error, detail }` (see `docs/spec/ERROR-HANDLING.md`).
- 503 returned when backend/libvirt is unreachable.
- API client builds thrown `Error` messages from the server's `error` response field (`data.error`; `data.message` is optional for compatibility). `detail` is available on the error object for expanders.

## Async & Timing (applied)

- No `sleep`, `setTimeout`, or `setInterval` to paper over race conditions. Use libvirt `DomainEvent` DBus signals or retry with exponential backoff via `setImmediate`.
- Other backend timers are fine for scheduling and housekeeping that is not a race workaround: e.g. the 2-second libvirt reconnect delay in `vmManager.connect()`, SSE push intervals in route handlers, job-store TTL cleanup after completed jobs, periodic apt update checks.
- File uploads: Fastify multipart piped to a write stream. Never buffer entire file in memory.
- Backup streams: source -> gzip -> destination in one pipeline. Never copy then compress.

## Architecture (applied)

- Only `backend/src/lib/linux/vmManager/` (and the `vmManager.js` facade) imports `dbus-next` for **libvirt** or calls libvirt. Avahi/mDNS uses `dbus-next` only in `linux/mdnsManager.js` (separate DBus service). New VM operations = new vmManager function.
- Prefer libvirt DBus API over shelling out to `virsh`.
- Fastify route response schemas are authoritative for serialized API output. When adding/changing response fields in a route handler, update the corresponding schema in `backend/src/routes/*.js` in the same edit, or Fastify may strip the new fields.
- Shell exec permitted for: `qemu-img` (disk ops), `cp --reflink=auto` with `copyFile` fallback (clone/backup), `cloud-localds`/`genisoimage` (cloud-init ISO), `openssl passwd` (password hashing), `xz` (HAOS decompress), `tar` (self-update tarball extract), `wisp-os-update` (OS package updates), `wisp-mount` (SMB shares + removable disks), `wisp-power` (host power), `wisp-dmidecode` (RAM info), `wisp-smartctl` (disk SMART summary), `wisp-netns` / `wisp-cni` (container netns + bridge CNI via `sudo -n`), `wisp-bridge` (managed VLAN bridge apply/remove via `sudo -n`), `systemctl start wisp-updater.service` (self-update atomic swap via `sudo -n`; the unit runs `/usr/local/bin/wisp-updater`), CNI plugins under `/opt/cni/bin/` (invoked by `wisp-cni` or dev-as-root). **Build-time only:** `git` (e.g. `frontend/scripts/ensure-novnc.js` / `vendor-novnc.sh` for noVNC). **macOS dev stubs only:** `system_profiler`, `vm_stat`, `sysctl`, and similar — not used on the Linux server. All other CLI usage must be validated with the team. New privileged `wisp-*` shims must be registered in `scripts/linux/setup/install-helpers.sh` and documented per **Privileged helpers checklist** in `docs/spec/DEPLOYMENT.md`.
- VM metadata (icons, etc.) stored in libvirt domain XML metadata — not localStorage.
- VM list updates via SSE (`/vms/stream`), not polling.
- CORS: allow `localhost:5173` only when `NODE_ENV=development`. Production: frontend proxies `/api` and `/ws`.

## Frontend / React (applied)

- Initialise form state from `vmConfig` defaults, not `useState({})`.
- `useEffect` depends on primitives or `JSON.stringify(array)`, never on object references that change every render.
- `useCallback` for `onConnect`/`onDisconnect` and similar callbacks to avoid effect loops.
- `ConfirmDialog` accepts `children` for custom content (Clone, Snapshot, Backup dialogs).
- Lazy-load heavy features (Console tab) with `React.lazy` / dynamic `import()`.
- List and table editing for repeating rows: follow [UI-PATTERNS.md](UI-PATTERNS.md) — row-scoped saves/operations, **header** add actions (`headerAction`), icon-only row actions, and shared table chrome (see that doc for exceptions such as bulk NIC/env saves).

## Security (applied)

- Cloud-init password passed to `openssl passwd -6` via stdin, not argv.
- SMB subprocess stderr sanitised (password masked as `***`) before client exposure.
- VM name validation: alphanumeric, hyphens, underscores, dots; reject `..`, `/`, empty, length > 128.
- Login endpoint rate-limited (in-memory).
- SSRF: block private/loopback IPs in user-supplied download URLs.
- WebSocket console route requires JWT verification.
- SMB temp directories created with restrictive umask.
- Rate limiting uses `request.ip` only (no `x-forwarded-for` fallback).

## Deployment & Scripts

- **Install:** Run `./scripts/install.sh` from the unpacked slim zip or repo; see [CONFIGURATION.md](docs/spec/CONFIGURATION.md#deployment-installsh).
- `push.sh`: runs `package.sh`, uploads zip via `scp`, runs `install.sh` on the server. Pass `--restart-svc` for unattended deploys.
- `setup-server.sh`: create VM storage directory (e.g. `/var/lib/wisp/vms`).
- `vendor-novnc.sh`: run with `bash` (not relying on execute bit).
- systemd: `EnvironmentFile=-/path/config/runtime.env` (optional file).
- Shell scripts: quote `"$!"` in PID captures; wrap `set +e`/`set -e` around commands that may fail intentionally.
- Templates live under `config/*.example`; live `config/` files are gitignored as appropriate.

## VM Domain XML Conventions

- Dual CDROM slots (sdc, sdd) defined at creation, even if empty. Empty = no `<source>`.
- Full CPU topology always: `<vcpu placement='static'>N</vcpu>` + `<cpu mode='host-passthrough'><topology sockets='1' dies='1' cores='N' threads='1'/></cpu>`.
- UEFI VMs: `<acpi/>` in `<features>`; writable NVRAM stored per-VM (`vms/<name>/VARS.fd`).
- USB tablet input device for VNC cursor sync.
- Cloud-init network config matches first NIC MAC from domain XML.

## Container Conventions

- **Single containerd caller**: Only `backend/src/lib/linux/containerManager/` imports `@grpc/grpc-js`. Routes and other libs must not import grpc-js directly.
- **containerManager facade**: New container operations = new purpose-named export from the `containerManager.js` facade.
- **container.json**: Source of truth for container config. Stored at `/var/lib/wisp/containers/<name>/container.json`.
- **OCI spec**: Generated by `linux/containerManager/containerManagerSpec.js` from container.json + image config. Never hand-edited.
- **CNI exec**: bridge CNI plugin invocation is the standard CNI interface, not a shell workaround.
- **Error pattern**: `containerError(code, message, raw?)` → `handleRouteError` → `{ error, detail }`. Same as vmManager.
- **Frontend store**: `containerStore.js` mirrors `vmStore.js` patterns. SSE for list, stats, and logs.
