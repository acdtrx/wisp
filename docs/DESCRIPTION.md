# Wisp — Project Description

The product philosophy: what Wisp is, for whom, and the boundaries that bind
design decisions. What exists and how it behaves lives in [`docs/spec/`](spec/)
— this file deliberately tracks intent, not the feature list.

## What is Wisp?

Wisp is a single-host workload management web application. It runs as a service on a Linux server and is accessed via a web browser from any machine on the same network. It manages QEMU/KVM virtual machines on the local host through the libvirt hypervisor interface, and OCI containers on the same host via containerd.

## Who is it for?

Wisp targets homelab users, prosumers, and small-team administrators who need a clean, modern web interface for managing VMs and containers on a single physical server. It is simple enough for occasional users while providing the power and flexibility expected by experienced virtualization users.

## Primary Goals

- **Minimal, uncluttered UI** — every screen earns its elements; no visual clutter. Light is the current default look; theming direction (e.g. dark mode) is a backlog matter, not a goal statement (settled 2026-08-11).
- **Full VM lifecycle management** — create, start, stop, reboot, suspend, resume, clone, delete, snapshot, backup, and restore virtual machines.
- **Container lifecycle** — create, configure, start, stop, and manage containers on containerd (bridge networking, mounts, logs), including app containers with dedicated configuration UIs.
- **In-browser consoles** — VNC graphical console for VMs and an interactive shell for containers, with no client software required.
- **Self-contained** — no CDN-linked assets at runtime. All JavaScript, CSS, and libraries are bundled or vendored and served locally. The application is fully functional with zero internet access on the server after installation.
- **Single-host scope** — manages VMs and containers on the machine where it is installed. No clustering, live migration, or multi-host orchestration.

## Design Philosophy

Product-level principles; the coding side — naming, dependency discipline,
integration boundaries, async patterns, shared components — is
[`docs/CODING-RULES.md`](CODING-RULES.md).

- **Features earn their place.** Wisp grows reluctantly: capabilities are added when a real need is observed, not to match other dashboards. Deferred ideas live in [`docs/BACKLOG.md`](BACKLOG.md), each with the trigger that would revisit it.
- **Appliance, not project.** Installing, updating, and running Wisp never requires manual server surgery: setup scripts, self-update from releases, a single systemd service. Fixes land in the app or its install pipeline.
- **The server runs complete on its own.** The browser is a window onto it: a refresh, a second device, or no client at all leaves the server's state and running operations unaffected.

## Capabilities

At the intent level: full VM lifecycle with snapshots, backups and restore, cloud-init provisioning, and USB passthrough; containers on containerd, including app containers created from templates with dedicated configuration UIs; an image library; in-browser VNC and shell consoles; host monitoring and hardware inventory; host management (SMB mounts, removable drives, VLAN bridges, power, OS updates); LAN discovery of peer Wisp instances; an MCP endpoint for coding agents; self-update from GitHub Releases. The authority on what exists and how it behaves is [`docs/spec/`](spec/) — one contract doc per area.

## Out of Scope

The following are deliberately not supported:

- **Multi-host management** — no clustering or orchestration; LAN discovery only links to peer instances, each managing its own host.
- **Live migration.**
- **Network-backed VM disk storage** (NFS, iSCSI) — VM disks live on local storage. SMB/CIFS mounts exist for backups, container mounts, and file shares; they are not VM disk backends (settled 2026-08-11).
- **PCI passthrough** (GPU, etc.) — USB passthrough only.
- **Multi-user accounts and role-based access control** — Wisp is single-user: one operator identity, one password; OIDC SSO is an optional login method for that same identity, not a user system. No LDAP (settled 2026-08-11).
- **A native or mobile-first app** — the web UI is responsive down to phones (see [`docs/spec/UI.md`](spec/UI.md) § Responsive behavior) but desktop-first: consoles, create flows, and drag-to-organize stay desktop-oriented (settled 2026-08-11).
- **Docker-based deployment** — Wisp is the platform such pipelines deploy onto; it runs bare-metal under systemd.
