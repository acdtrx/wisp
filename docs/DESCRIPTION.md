# Wisp — Project Description

## What is Wisp?

Wisp is a single-host workload management web application. It runs as a service on a Linux server and is accessed via a web browser from any machine on the same network. It manages QEMU/KVM virtual machines on the local host through the libvirt hypervisor interface, and OCI containers on the same host via containerd.

## Who is it for?

Wisp targets homelab users, prosumers, and small-team administrators who need a clean, modern web interface for managing VMs and containers on a single physical server. It is simple enough for occasional users while providing the power and flexibility expected by experienced virtualization users.

## Primary Goals

- **Modern, minimal UI** — professional light-theme dashboard inspired by tools like Linear and Vercel. No visual clutter.
- **Full VM lifecycle management** — create, start, stop, reboot, suspend, resume, clone, delete, snapshot, backup, and restore virtual machines.
- **Container lifecycle** — create, configure, start, stop, and manage containers on containerd (bridge networking, mounts, logs).
- **In-browser graphical console** — VNC console access to running VMs directly from the web UI, with no client software required.
- **Self-contained** — no CDN-linked assets at runtime. All JavaScript, CSS, and libraries are bundled or vendored and served locally. The application is fully functional with zero internet access on the server after installation.
- **Single-host scope** — manages VMs and containers on the machine where it is installed. No clustering, live migration, or multi-host orchestration.

## Design Philosophy

- **Minimal dependencies** — use platform built-ins where possible. Only add a dependency when it provides substantial functionality that would take significant effort to replicate.
- **Purpose-named operations** — every function is named for what it does, not for the underlying system call. No generic string-switch dispatchers.
- **Single integration boundary** — all hypervisor communication is isolated in a single internal module. No other part of the codebase touches the hypervisor directly. Containers use a separate facade (`containerManager`) for containerd.
- **No race condition workarounds** — state-transition waits use event-driven signals or retry with exponential backoff, never sleep/timeout polling.
- **Shared components** — the same UI components are used across different views (e.g. VM overview and VM creation) to prevent duplication.

## Key Features

| Feature | Description |
|---------|-------------|
| VM Lifecycle | Create, start, stop, reboot, suspend, resume, clone, delete |
| VM Configuration | CPU, RAM, disks, network, firmware, boot order, advanced settings |
| VNC Console | In-browser graphical console for running VMs |
| Containers | OCI images on containerd: lifecycle, mounts, env, logs, stats |
| Image Library | Upload, download, and manage ISO and disk images |
| Cloud-Init | Automated VM provisioning with hostname, user, SSH keys, packages |
| Snapshots | Create, revert, and delete VM snapshots |
| Backups | Full VM backup to local storage or an optional SMB network mount, with restore |
| USB Passthrough | Attach and detach host USB devices to VMs (hot-plug supported) |
| Host Monitoring | Real-time CPU, RAM, disk I/O, and network stats for host; per-VM stats (vCPU usage, disk/net I/O, uptime, optional guest hostname/IP) |
| Settings | Server configuration, network storage (SMB mounts), backup options, password management |
| OS Updates | Check and install system package updates from the UI |

## Out of Scope

The following are explicitly not supported:

- Multi-host / clustering
- Live migration
- Network-based storage (NFS, iSCSI)
- PCI passthrough (GPU, etc.) — USB passthrough only
- LDAP / OAuth / multi-user authentication
- Role-based access control
- Mobile-optimized layout
- Docker-based deployment
