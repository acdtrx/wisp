# Tech Stack

This is the single source of truth for all technology choices in the project. No other spec file should name specific libraries or frameworks unless the technology is inherent to the domain (e.g. libvirt, QEMU, DBus).

## Backend

| Component | Technology | Version | Purpose |
|-----------|-----------|---------|---------|
| Runtime | Node.js | 24+ LTS | Server runtime. Optional `config/runtime.env` parsed in-process; `--watch` for dev mode. |
| Framework | Fastify | ^5.8 | HTTP server with built-in JSON schema validation, low overhead, plugin system. |
| CORS | @fastify/cors | ^11.2 | Cross-origin support for development mode only. |
| File uploads | @fastify/multipart | ^9.4 | Streaming multipart uploads (50GB limit). |
| WebSocket | @fastify/websocket | ^11.2 | WebSocket support for VNC console proxy and container interactive shell. |
| Hypervisor | dbus-next | ^0.10 | Pure-JS DBus client for communicating with libvirt via its DBus API (`org.libvirt`). Chosen over native bindings (node-libvirt) because it requires no native compilation, works across Node versions, and libvirt's DBus API is a stable first-class interface. |
| XML parsing | fast-xml-parser | ^5.5.7 | Parse and build libvirt domain XML. No regex-based XML manipulation anywhere. |
| gRPC client | @grpc/grpc-js | ^1.14.3 | gRPC client for communicating with containerd via its unix socket API. |
| Proto loader | @grpc/proto-loader | ^0.8.0 | Dynamic protobuf definition loading for containerd proto files. |
| Proto encoding | protobufjs | ^8.0.0 | Binary protobuf encoding for containerd Transfer API `Any` fields. Direct usage needed because `@grpc/proto-loader` only exposes descriptor objects, not encodable Type instances. |

### Backend dependencies NOT used

- **No Express** — Fastify chosen for performance and built-in validation.
- **No native libvirt bindings** — unmaintained, require native compilation.
- **No stats library** — host metrics read directly from `/proc`.
- **No JWT library** — JWT signing/verification implemented with Node.js `crypto` built-ins.
- **No UUID library** — `crypto.randomUUID()` or libvirt-generated UUIDs.
- **No date library** — built-in `Date` and `Intl` APIs.

## Frontend

| Component | Technology | Version | Purpose |
|-----------|-----------|---------|---------|
| UI library | React | ^18.3 | Component-based UI. |
| Build tool | Vite | ^6.4.2 | Dev server with HMR, production bundler. |
| Vite plugin | @vitejs/plugin-react | ^4.3 | JSX transform and React fast refresh. |
| Styling | Tailwind CSS | ^3.4 | Utility-first CSS framework. Custom theme with project-specific design tokens. |
| CSS processing | PostCSS + Autoprefixer | ^8.4 / ^10.4 | Required by Tailwind for CSS processing. |
| State management | Zustand | ^5.0 | Minimal global state with no boilerplate. |
| Routing | react-router-dom | ^6.28 | Client-side routing (login page vs. app shell). |
| Icons | lucide-react | ^0.468 | Tree-shakeable icon library. No CDN. |
| HTTP client | Native `fetch` | — | No Axios or similar; plain browser fetch API. |
| VNC console | noVNC | vendored | ESM source files served from `public/vendor/novnc/`. Not installed via npm. See [noVNC.md](spec/noVNC.md). |
| Container console | @xterm/xterm | ^6.0 | In-browser terminal emulator for container shell sessions. |
| Terminal layout | @xterm/addon-fit | ^0.11 | Fits the terminal to its container element; paired with resize WebSocket control messages. |

### Frontend production server

| Component | Technology | Version | Purpose |
|-----------|-----------|---------|---------|
| Server | Fastify | ^5.8 | Serves built static files and proxies `/api` + `/ws` to backend. |
| Static files | @fastify/static | ^9.0 | Serves `dist/` (Vite build output) and `public/vendor/` (noVNC). |
| Proxy | @fastify/http-proxy | ^11.4 | Proxies API and WebSocket requests to the backend process. |

### Frontend dependencies NOT used

- **No component library** (Material UI, Chakra, etc.) — all components built from scratch with Tailwind.
- **No CSS-in-JS** — Tailwind utility classes only.
- **No Axios** — native `fetch`.
- **No form library** — plain React state for forms.
- **No CDN assets** — no external font loading, no script tags from CDNs.

## Vendored Dependencies

| Dependency | Source | Location | Reason |
|-----------|--------|----------|--------|
| noVNC core | GitHub (novnc/noVNC) | `frontend/public/vendor/novnc/core/` | npm package has top-level `await` in CJS that Rollup cannot process. Vendored as raw ESM source, loaded via dynamic `import()` at runtime. |
| pako | Bundled with noVNC | `frontend/public/vendor/novnc/vendor/pako/` | Compression library used by noVNC. Copied from noVNC's vendor directory. |

## System Dependencies (Linux host)

Installed by the server setup script:

| Package | Purpose |
|---------|---------|
| qemu-kvm | KVM hypervisor |
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

## CLI Tools Used by Backend

These are invoked via `child_process` where no native Node.js alternative exists:

| Tool | Used for |
|------|----------|
| `unzip` | Container directory mount `.zip` extraction (after `unzip -Z1` path validation) |
| `qemu-img` | Disk creation, copy/convert, resize, info |
| `cloud-localds` | Cloud-init seed ISO generation (preferred) |
| `genisoimage` | Cloud-init seed ISO generation (fallback) |
| `openssl` | Password hashing for cloud-init (`openssl passwd -6`) |
| `cp` | Fast disk copy with `--reflink=auto` when available; falls back to Node `copyFile` (clone/backup) |
| `xz` | Decompress HAOS `.qcow2.xz` downloads (`xz -dc`) |
| `wisp-power` | Host shutdown/reboot (privileged helper; see CONFIGURATION) |
| `wisp-dmidecode` | RAM module info via `dmidecode` (privileged helper; see HOST-MONITORING) |
| `wisp-os-update` | OS package update check/upgrade — Debian/Ubuntu (apt) and Arch (pacman); distro detected at runtime (privileged helper) |
| `wisp-mount` | SMB + removable-disk mount/unmount/check (privileged helper) |
| `wisp-smartctl` | Disk SMART summary (`smartctl --json`; privileged helper) |
| `wisp-bridge` | Managed VLAN bridges via netplan (privileged helper) |
| `/opt/cni/bin/bridge` | CNI bridge plugin exec for container networking (standard CNI interface) |
| `/opt/cni/bin/dhcp` | CNI DHCP daemon for container IP assignment |
| `ip` | Network namespace management (`ip netns add/delete`) for containers |

## Deployment

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Process manager | systemd | Two service units: backend and frontend |
| Deployment | scp + SSH (`scripts/push.sh`) | Packages a zip (`package.sh`), uploads to `/tmp` on the server, runs `install.sh` over SSH |
| Privileged helpers | `install-helpers.sh` | Refreshes `/usr/local/bin/wisp-*` from `backend/scripts/` on install/upgrade (`setup-server.sh`, `wispctl helpers`, `push.sh`) |
| Packaging | zip | Deployment archive for manual server setup |
| Containerization | None | No Docker. Services run directly on the Linux host. |

## Dependency Philosophy

Use the platform where possible. Only add an npm package if it provides substantial functionality that would take significant effort to replicate correctly (e.g. `dbus-next` for DBus protocol, `fast-xml-parser` for XML handling, `fastify` for HTTP server, `zustand` for state). Do not add packages for things like date formatting, simple HTTP requests, UUID generation, or JWT handling — use Node.js built-ins or small inline implementations instead.

## Fonts

System fonts only. No font downloads, no CDN font loading. Body UI uses the sans stack below; Tailwind `font-mono` (or equivalent) is allowed for code paths, XML, and technical strings using the **system monospace** stack only (no webfonts).

```
font-family: system-ui, -apple-system, sans-serif
```
