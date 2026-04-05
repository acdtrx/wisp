# Wisp

**Wisp** is a web application for managing **KVM/QEMU virtual machines** and **containerd-backed containers** on a Linux host. It talks to **libvirt** over D-Bus, exposes a REST API and live updates (SSE), and ships with a React frontend for day-to-day VM and host operations (lifecycle, storage, console, backups, networking, and more).

This project was **vibe coded** with [Cursor](https://cursor.com) and other AI-assisted tooling. You are welcome to **clone the repository** and open it in Cursor, VS Code with Copilot, or any AI-capable IDE to adapt behavior, branding, or integrations to your needs.

## What it runs on

- **Production:** **Linux only** — **Debian/Ubuntu** or **Arch Linux** (see `scripts/linux/setup/distro.sh`). The stack expects **KVM**, **libvirt**, **QEMU**, **containerd**, and related packages installed by the project’s setup scripts.
- **Runtime:** **Node.js 24+** (backend and frontend build/serve).
- **Development:** The backend can run on **macOS** without libvirt for UI/API work; full hypervisor features require a Linux machine with libvirt.

**Trying it safely:** A good approach is to install Wisp on a **dedicated Linux VM** and enable **nested virtualization** on the hypervisor so guest VMs can use KVM inside the VM. Nested virt depends on your CPU and host hypervisor (Intel VT-x/AMD-V and host support for nested); see your platform’s documentation.

## Security and responsibility

Wisp is a **single-password, single-operator** control plane with **full access to libvirt, storage paths, and optional SMB credentials** on the host. Run it only on hosts and networks you trust, protect the login and config files, and treat issues in this category as **security-sensitive** when reporting (see below).

## Installation

High-level flow (details and options are in **`docs/spec/DEPLOYMENT.md`**):

1. Clone this repository on the target Linux server.
2. Run **one-time host preparation** as root:  
   `sudo ./scripts/setup-server.sh`  
   (installs packages, libvirt/containerd setup, directories, helpers, etc.)
3. Run **install** as your deploy user from the repo root:  
   `./scripts/install.sh`  
   (copies files to the install directory, configures `config/`, builds frontend/backend, optional systemd units).

After install, access the app in the browser (default frontend port **8080** unless overridden in `config/runtime.env`). Set or rotate the login password with `./scripts/wispctl.sh password` if needed.

## Documentation

Authoritative technical docs live under **`docs/`**, including architecture (`docs/ARCHITECTURE.md`), API (`docs/spec/API.md`), deployment (`docs/spec/DEPLOYMENT.md`), and feature-specific specs in `docs/spec/`.

## Bugs and feedback

Please **report bugs and feature requests** via **GitHub Issues** in this repository once it is published.

## License

Wisp is released under the **MIT License** — see [`LICENSE`](./LICENSE). You may use, modify, and distribute the project with minimal restrictions; the license text is the canonical grant of permissions.
