# Tech Stack

> What Wisp is built with, and why. When the project deviates, edit the section in place
> (`AGENTS.md`, Documentation): this file describes the project's actual stack, not a menu.

## Server

- **Node.js 24+ LTS**, ESM only, **plain JavaScript — no TypeScript** (deviation: the
  codebase predates the TypeScript default; a migration would be its own spec-sized
  decision, not a routine upgrade).
- npm; `npm ci` for reproducible installs, and the lockfile ships with deploys. No
  `dotenv` — the optional `config/runtime.env` is parsed in-process.
- The **zero-native-deps goal holds** — it is why `dbus-next` (pure JS) was chosen over
  native libvirt bindings.
- **Domain integrations**, outside any conventional web stack: **`dbus-next`** (libvirt's
  DBus API in `lib/vmManager/linux/`, Avahi's in `lib/mdns/linux/` — its only two
  callers), **`@grpc/grpc-js`** + proto-loader + protobufjs (containerd's gRPC API — sole
  caller `lib/containerManager/linux/`), **`fast-xml-parser`** (libvirt domain XML, never
  regex).
- **Fastify 5.** **Schema validation: JSON Schema with ajv**, which ships inside Fastify
  and checks every route's input. Routes throw, and one error handler answers every
  failure, validation errors included, with the failure shape and the status the one
  table of codes gives it (CODING-RULES §5). Route **response schemas are
  authoritative** for serialized output: add a new response field to the route schema in
  the same edit, or Fastify strips it. Plugins: cors, multipart (streamed uploads),
  static (serves the SPA + vendored noVNC), websocket (VNC proxy, container shell). CORS
  allows `localhost:5173` in development only; in production the backend serves its own
  client, same origin.
- **Logging: pino** — pino-pretty single-line in dev, plain JSON in production.
- **`undici`** used directly for SSRF-hardened fetches — only in `lib/downloads/`;
  **`js-yaml`** for cloud-init YAML emission.
- **Auth:** password login yielding `node:crypto`-signed session JWTs in cookies (no JWT
  library), optional library-less OIDC SSO layered on top (the password stays as backup —
  the session secret derives from it), scoped bearer API tokens (read/admin) and the
  `/mcp` endpoint for agents. Contract: [specs/AUTH.md](specs/AUTH.md).
- **No database**: state is libvirt domain XML and JSON files (`ARCHITECTURE.md`, State).
- **SSE** for server→client updates. The client reads it through the custom fetch-based
  `createSSE`: native `EventSource` was evaluated and rejected — it can't observe
  keepalive comments (no dead-TCP watchdog) nor distinguish 401s.

## Client

- **React 19** SPA, **Vite 8** (Rolldown-based), **Tailwind 4** CSS-first (`@theme` in
  `index.css`) + typography plugin, **Zustand** stores, `lucide-react`, `marked` +
  `dompurify`, native `fetch`.
- **`react-router-dom` v7 declarative mode** — the successor package is `react-router`
  v8; the upgrade is a recorded block per `CODING-RULES.md` §3, rechecked on the next
  routing-touching work.
- Hand-written service worker (no PWA plugin); **noVNC vendored** as ESM source (its npm
  package can't be bundled); `@xterm/xterm` for container shells.

## Testing & lint

- **Manager paths have no automated tests** (deviation) — they are verified by running
  the real app (`CODING-RULES.md` §14); macOS dev runs stub managers (settled
  2026-11-18).
- **Unit tests on `node --test`**, Node's built-in runner, with no test framework or
  dependency, for code with no platform behind it; browser stand-ins in
  `frontend/src/testing/`; a migration's transform is tested in
  `backend/migrations/test/`, a subdirectory the migration loader never reads, reached by
  the root `test` script through rule 6's one allowance in `scripts/check-fences.mjs`
  (settled 2026-11-20). Setup's Python has its unit tests the same way: `unittest`,
  the standard library's runner, over `scripts/linux/setup/*_test.py` beside the code
  they test (`npm run check`'s `setup-python`). Test files never ship:
  `scripts/stage-release.sh` leaves out `*.test.js` and `*_test.py` and fails a staged
  tree or tarball that holds one (settled 2026-11-18; the Python tests 2026-11-20).
  The operation modules' tests (`lib/vmOperations.js`, `lib/containerOperations.js`)
  stand the managers and the stores in with Node's module mocks (`mock.module`), so
  the root `test` script runs with `--experimental-test-module-mocks`: the commands
  are tested without a test seam in production code (settled 2026-11-20).
- **ESLint**, a dev-only dependency of the repo root with its React hooks plugin and
  `globals`, for correctness rules only: `no-undef`, `no-unused-vars` (rest siblings
  ignored), `no-dupe-keys`, `react-hooks/rules-of-hooks`. No style rule;
  `react-hooks/exhaustive-deps` stays off until the hooks that own the dependency
  arrays exist. A hand-written scan was rejected: an undefined name needs scope
  analysis (settled 2026-11-18).
- **The other checks are dependency-free Node scripts** in `scripts/` (`check-imports`,
  `check-fences`, the shell check): dumb scans for what ESLint does not see (the
  fences, names across backend files, facade parity, cycles, shell syntax).
  `npm run check` runs them, ESLint and the unit tests, and the release workflow and
  `scripts/release.sh` run it. What each covers, and when to run it:
  `CODING-RULES.md` §14. The frontend build checks the client's imports.

## Deployment

- **Bare-metal systemd** (`wisp.service`, one process for API + SPA) — deliberate
  deviation from a container pipeline: Wisp **is** the platform that pipeline deploys
  onto, so it runs on the host, not in a container. Self-update from GitHub Releases via
  `wisp-updater` atomic swap. No Docker anywhere in the project. The flow:
  `PRODUCTION.md`, Deploys.

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Process manager | systemd | Single service unit (`wisp.service`) — one Node process serves both API and SPA. |
| Deployment | scp + SSH (`scripts/push.sh`) | Stages the release-shaped tarball, uploads it to `/tmp` on the server, runs its `install.sh` over SSH |
| Setup's Python | Python 3 (`scripts/linux/setup/*.py`) | Setup and the installer only, where Node may not be installed yet: as root, but for `install-state.py`, which the answers step also runs as the deploy user (`config.sh`). The network plan's parsers: they read the network's configuration and JSON (netplan's YAML and its parser, networkd's units, `networkctl`'s and `ip`'s JSON, cloud-init's configuration) with a real parser. And two helpers: `dpkg-locked.py`, the packages step's dpkg run holding dpkg's frontend lock as apt does; `install-state.py`, the installer's and the answers step's reading of whether `wisp-config.json` names the server. The standard library, plus netplan's own `netplan` module and PyYAML, which netplan.io installs with it, as it does `python3` itself: the plan runs no Python before it knows netplan is there (DEPLOYMENT.md, Supported hosts; settled 2026-11-20). Not jq or Node: neither is on a fresh host, and Node is what the packages step installs (settled 2026-11-19). |
| Privileged helpers | `install-helpers.sh` | Setup's helpers step: copies `/usr/local/bin/wisp-*` from `backend/scripts/` where they differ, on every install and update |
| Packaging | tar.gz (`scripts/stage-release.sh`) | One release-shaped tarball, prebuilt frontend, for releases and dev pushes alike |
| Releases | GitHub Releases + GitHub Actions (`.github/workflows/release.yml`) | Tag `v*` triggers a workflow that builds the frontend and publishes a tarball + SHA256 as a GitHub Release |
| Self-update | `backend/src/lib/wispUpdate.js` + `wisp-updater.service` (Type=oneshot, runs `/usr/local/bin/wisp-updater`) | Hourly poll of GitHub Releases; in-app Install button downloads, verifies, atomic-swaps via the dedicated systemd unit. See [specs/UPDATES.md](specs/UPDATES.md) |
| Containerization | None | No Docker. Services run directly on the Linux host. |

## Dependencies

Rules: `CODING-RULES.md` §3. Each line: what it is for, and what it saves.

### Inventory

#### Repo root (dev only)

Never on a host: the release tarball and the dev zip carry the root `package.json`
alone, and nothing installs the root's packages there.

| Component | Technology | Version | Purpose |
|-----------|-----------|---------|---------|
| Lint | eslint | ^10.15 | Correctness rules over `backend/` and `frontend/src/` (Testing & lint, above); flat config in `eslint.config.mjs`. |
| Lint plugin | eslint-plugin-react-hooks | ^7.1 | `rules-of-hooks`. Version 7 brings in `@babel/core`, `hermes-parser` and `zod` for its React Compiler rules, which stay off; version 5 does not support ESLint 10. |
| Lint globals | globals | ^17.14 | The browser and Node global names `no-undef` needs, rather than a hand-kept list. |

#### Backend

| Component | Technology | Version | Purpose |
|-----------|-----------|---------|---------|
| Runtime | Node.js | 24+ LTS | Server runtime. Optional `config/runtime.env` parsed in-process; `--watch` for dev mode. |
| Framework | Fastify | ^5.8 | HTTP server with built-in JSON schema validation, low overhead, plugin system. |
| CORS | @fastify/cors | ^11.2 | Cross-origin support for development mode only. |
| File uploads | @fastify/multipart | ^10.0 | Streaming multipart uploads (50GB limit). |
| Static files | @fastify/static | ^10.1 | Serves the prebuilt SPA (`frontend/dist/`) and `/vendor/` (noVNC). |
| WebSocket | @fastify/websocket | ^11.2 | WebSocket support for VNC console proxy and container interactive shell. |
| Hypervisor | dbus-next | ^0.10 | Pure-JS DBus client for communicating with libvirt via its DBus API (`org.libvirt`). Chosen over native bindings (node-libvirt) because it requires no native compilation, works across Node versions, and libvirt's DBus API is a stable first-class interface. |
| XML parsing | fast-xml-parser | ^5.5.7 | Parse and build libvirt domain XML. No regex-based XML manipulation anywhere. |
| gRPC client | @grpc/grpc-js | ^1.14.3 | gRPC client for communicating with containerd via its unix socket API. |
| Proto loader | @grpc/proto-loader | ^0.8.0 | Dynamic protobuf definition loading for containerd proto files. |
| Proto encoding | protobufjs | ^8.0.0 | Binary protobuf encoding for containerd Transfer API `Any` fields. Direct usage needed because `@grpc/proto-loader` only exposes descriptor objects, not encodable Type instances. |
| Log pretty-print (dev only) | pino-pretty | ^13.1 | `devDependency`. Single-line, time-formatted log output when `NODE_ENV=development`. Production keeps Pino's default JSON output. |
| HTTP client | undici | ^8.7 | Used directly for SSRF-hardened fetches: single-DNS-resolve + IP-pinned `Agent` + manual redirect re-validation. Node ships undici as the global `fetch`; we depend on it explicitly to import `Agent` / `fetch`. v8 negotiates HTTP/2 by default. |
| YAML emitter | js-yaml | ^5.2 | `dump()` (named export; v5 has no default export) for cloud-init `user-data` / `meta-data`. Replaces hand-rolled template-literal YAML which was vulnerable to scalar-break injection from user-controlled fields. |

#### Backend: not used

- **No Express** — Fastify chosen for performance and built-in validation.
- **No native libvirt bindings** — unmaintained, require native compilation.
- **No stats library** — host metrics read directly from `/proc`.
- **No JWT library** — JWT signing/verification implemented with Node.js `crypto` built-ins.
- **No UUID library** — `crypto.randomUUID()` or libvirt-generated UUIDs.
- **No date library** — built-in `Date` and `Intl` APIs.
- **No semver library** — `compareSemver` in `wispUpdate.js` handles prerelease precedence per the semver spec (settled 2026-08-25).

#### Frontend

| Component | Technology | Version | Purpose |
|-----------|-----------|---------|---------|
| UI library | React | ^19.2 | Component-based UI. |
| Build tool | Vite | ^8.1 | Dev server with HMR, production bundler (Rolldown-based; vendor chunk via `build.rolldownOptions.output.codeSplitting`). |
| Vite plugin | @vitejs/plugin-react | ^6.0 | JSX transform and React fast refresh (Oxc-based, no Babel). |
| Styling | Tailwind CSS | ^4.3 | Utility-first CSS framework. CSS-first config: design tokens live in `src/index.css` `@theme` (no `tailwind.config.js`). Integrated via the first-party `@tailwindcss/vite` plugin — no PostCSS/Autoprefixer (v4 handles prefixing). |
| Tailwind plugin | @tailwindcss/typography | ^0.5 | `prose` utility classes for rendering arbitrary markdown content (release notes). Loaded via `@plugin` in `src/index.css`. Known `npm audit` moderate (2026-10-16): it pins `postcss-selector-parser@6.0.10` exactly (GHSA-rj75-hqrm-r3gf, quadratic selector parsing). Build-time only and it parses our own CSS, so not reachable; no override. Recheck when a typography release moves to `postcss-selector-parser` ≥7.1.6. |
| State management | Zustand | ^5.0 | Minimal global state with no boilerplate. |
| Routing | react-router-dom | ^7.18 | Client-side routing (login page vs. app shell). Declarative mode (`BrowserRouter`/`Routes`). |
| Icons | lucide-react | ^1.23 | Tree-shakeable icon library. No CDN. v1 dropped brand icons (GitHub → `AtSign` in cloud-init section). |
| Markdown | marked + dompurify | ^18 / ^3 | Parses GitHub-flavored release notes (marked) and sanitizes the HTML (dompurify) before injection in the Wisp Update section. |
| HTTP client | Native `fetch` | — | No Axios or similar; plain browser fetch API. |
| Offline shell | Native Service Worker | — | Hand-written `public/sw.js` (~140 lines); no Workbox / `vite-plugin-pwa`. Precache list baked into `dist/sw.js` at build time by `scripts/generate-sw-precache.js` from Vite's build manifest (`build.manifest: true`). Requires a secure context (HTTPS or localhost). |
| VNC console | noVNC | vendored, pinned in `scripts/vendor-novnc.sh` | ESM source files served from `public/vendor/novnc/`. Not installed via npm. See [noVNC.md](specs/noVNC.md). |
| Container console | @xterm/xterm | ^6.0 | In-browser terminal emulator for container shell sessions. |
| Terminal layout | @xterm/addon-fit | ^0.11 | Fits the terminal to its container element; paired with resize WebSocket control messages. |

#### Frontend: not used

- **No component library** (Material UI, Chakra, etc.) — all components built from scratch with Tailwind.
- **No CSS-in-JS** — Tailwind utility classes only.
- **No Axios** — native `fetch`.
- **No form library** — plain React state for forms.
- **No CDN assets** — no external font loading, no script tags from CDNs.
- **No PWA plugin** (`vite-plugin-pwa`, Workbox) — the service worker needs exactly two caching strategies and a build-time precache list; both are a few lines against the platform API.

#### Vendored Dependencies

| Dependency | Source | Location | Reason |
|-----------|--------|----------|--------|
| noVNC core | GitHub (novnc/noVNC) | `frontend/public/vendor/novnc/core/` | npm package has top-level `await` in CJS that Rollup cannot process. Vendored as raw ESM source, loaded via dynamic `import()` at runtime. |
| pako | Bundled with noVNC | `frontend/public/vendor/novnc/vendor/pako/` | Compression library used by noVNC. Copied from noVNC's vendor directory. |

#### System Dependencies (Linux host)

Installed by the server setup script:

| Package | Purpose |
|---------|---------|
| qemu-system-x86 | KVM hypervisor (replaces the old `qemu-kvm` transitional package, which was dropped in Ubuntu 24.04) |
| libvirt-daemon-system | Libvirt daemon and management |
| libvirt-clients | CLI tools (virsh, etc.) |
| libvirt-dbus | DBus interface for libvirt (required for dbus-next communication) |
| ovmf | UEFI firmware for VMs |
| swtpm | Software TPM for Windows VMs |
| avahi-daemon | mDNS/DNS-SD daemon used for publishing VM/container `.local` hostnames when Local DNS is enabled |
| cloud-image-utils | `cloud-localds` for cloud-init ISO generation |
| genisoimage | Fallback ISO generation when `cloud-localds` is unavailable |
| qemu-utils | `qemu-img` for disk operations (create, convert, resize, info) |
| hwdata | `pci.ids` and `usb.ids` under `/usr/share/hwdata/`; Host Overview PCI names and USB name fallback (files read by the app; no `lspci`/`lsusb`) |
| cifs-utils | SMB mount support for network storage mounts |
| containerd.io | Container runtime (2.0+); managed via gRPC from the backend |
| unzip | Info-ZIP `unzip` — extracts `.zip` uploads for container directory mounts (`unzip -Z1` + `unzip -d`) |
| CNI plugins | bridge, dhcp, loopback — container networking (installed to `/opt/cni/bin/`) |

#### CLI Tools Used by Backend

These are invoked via `child_process` where no native Node.js alternative exists; the allowlist itself is `CODING-RULES.md` §7:

| Tool | Used for |
|------|----------|
| `unzip` | Container directory mount `.zip` extraction (after `unzip -Z1` path validation) |
| `qemu-img` | Disk creation, copy/convert, resize, info |
| `cloud-localds` | Cloud-init seed ISO generation (preferred) |
| `genisoimage` | Cloud-init seed ISO generation (fallback) |
| `openssl` | Password hashing for cloud-init (`openssl passwd -6`) |
| `cp` | Fast disk copy with `--reflink=auto` when available; falls back to Node `copyFile` (backup, restore) |
| `xz` | Decompress HAOS `.qcow2.xz` downloads (`xz -dc`) |
| `wisp-power` | Host shutdown/reboot (privileged helper; see CONFIGURATION) |
| `wisp-dmidecode` | RAM module info via `dmidecode` (privileged helper; see HOST-MONITORING) |
| `wisp-os-update` | OS package update check/upgrade with apt (privileged helper) |
| `wisp-mount` | SMB + removable-disk mount/unmount/check (privileged helper) |
| `wisp-smartctl` | Disk SMART summary (`smartctl --json`; privileged helper) |
| `wisp-bridge` | Managed VLAN bridges via netplan (privileged helper) |
| `/opt/cni/bin/bridge` | CNI bridge plugin exec for container networking (standard CNI interface) |
| `/opt/cni/bin/dhcp` | CNI DHCP daemon for container IP assignment |
| `ip` | Network namespace management (`ip netns add/delete`) for containers |
| `systemd-notify` | `--ready` once the backend listens: wisp.service is `Type=notify` (skipped without `NOTIFY_SOCKET`) |
