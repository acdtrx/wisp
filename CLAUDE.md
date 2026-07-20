# Wisp — Project Pointer

This project's working rules live in **kora**, the user's knowledge base (MCP
server `kora`). Before working, read these kora documents (search by title):

- **Wisp — Agent Rules** — triage, plans, verification, debugging, docs sync,
  git, deployability, kora duties.
- **Wisp — Coding Rules** — coding principles. `CODING-RULES §N` comments in
  the source refer to its numbered sections.

The backlog and ideas live in kora too (`Backlog: <item>` / `Idea: <item>`
notes, tag `wisp`) — never as repo files. Specs (`docs/spec/`), plans
(`docs/plans/`), UI patterns (`docs/UI-PATTERNS.md` — required reading for any
UI with tables or row editors), architecture and tech-stack docs, and the
backend mechanics notes (`backend/src/lib/CLAUDE.md`) stay in this repo. If
kora is unreachable, say so and work from the rails below plus the repo docs —
never invent a rule from memory.

## Facts & commands

- Single-user manager for KVM/QEMU VMs (libvirt over DBus) and containerd
  containers on one Linux host. Backend: Node.js + Fastify (`backend/`);
  frontend: React + Vite + Tailwind, Zustand stores, live data over SSE
  (`frontend/`). Production runs as a single `wisp.service`; self-update from
  GitHub Releases via `wisp-updater`.
- Backend dev: `cd backend && NODE_ENV=development npm run dev` → `127.0.0.1:8080`
- Frontend dev: `cd frontend && npx vite --port 5173` (proxies `/api` + `/ws` to `:8080`)
- Frontend build: `cd frontend && npm run build`
- macOS dev runs stub managers (no libvirt/containerd): host-level pages work,
  workload detail needs the Linux server or a component harness.
- Release (user-initiated, releases are batched): `scripts/release.sh`; the
  `v*` tag builds the `wisp-<version>.tar.gz` artifact via GitHub Actions.

## Hard rails (apply even without kora access)

- **Never `git push` unless explicitly asked.** Default push remote is `cala`;
  `github` is releases only. No PRs — branch + `git merge --ff-only` to main.
- Update `CHANGELOG.md` before every push (new dated section at the top). When
  cutting a release, leave it uncommitted — `scripts/release.sh` folds it in.
- **No migrations / legacy-cleanup code** (feature-building mode) — not even
  for artifacts produced earlier in the same session.
- **Shell-exec allowlist.** Prefer DBus/gRPC APIs over shelling out. Exec is
  permitted only for: `qemu-img`, `cp --reflink=auto` (with `copyFile`
  fallback), `cloud-localds`/`genisoimage`, `openssl passwd`, `xz`, `tar`, the
  privileged helpers `wisp-os-update`, `wisp-mount`, `wisp-power`,
  `wisp-dmidecode`, `wisp-smartctl`, `wisp-nvram`, `wisp-netns`, `wisp-cni`,
  `wisp-bridge`, `systemctl start wisp-updater.service` (via `sudo -n`), and
  CNI plugins under `/opt/cni/bin/`. Build-time only: `git` (noVNC vendoring).
  macOS dev stubs only: `system_profiler`, `vm_stat`, `sysctl`. Anything else
  needs user validation first. New privileged `wisp-*` helpers must be
  registered in `scripts/linux/setup/install-helpers.sh` and documented per
  the checklist in `docs/spec/DEPLOYMENT.md`.
- No CDN assets — all JS, CSS, and fonts bundled or system defaults.
