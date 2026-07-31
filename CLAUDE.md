# Wisp — Project Rules

The working rules for this repo. Read this and [`docs/CODING-RULES.md`](docs/CODING-RULES.md)
before working; `CODING-RULES §N` comments in the source refer to its numbered
sections.

What lives where:

- **This file** — working method, hard rails, the authoritative shell-exec allowlist.
- [`docs/CODING-RULES.md`](docs/CODING-RULES.md) — coding principles, always applicable.
- [`docs/UI-PATTERNS.md`](docs/UI-PATTERNS.md) — required reading for any UI with tables, lists, or row editors.
- [`docs/TECH-STACK.md`](docs/TECH-STACK.md) — the stack at a glance plus the full dependency inventory.
- [`docs/spec/`](docs/spec/) — the contract docs, one per area.
- [`docs/plans/`](docs/plans/) — plans for large work.
- [`backend/src/lib/CLAUDE.md`](backend/src/lib/CLAUDE.md) — file-level backend mechanics.
- **kora** (MCP server `kora`) — the backlog and ideas (`Backlog: <item>` / `Idea: <item>` notes, tag `wisp`), never as repo files, plus the project overview and homelab deployment context.

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

## Triage

Classify every request before acting:

- **Small** — bug fix, rename, config tweak, isolated change (roughly one subsystem): implement directly after the required reading below. No plan files, no ceremony.
- **Large** — new feature, refactor, anything spanning multiple subsystems or sessions: pre-implementation analysis and a plan in `docs/plans/`.

When unsure, ask — a one-line question is cheaper than a wrong plan or a sprawling "small" fix.

## Pre-implementation analysis

1. **Read first.** [`docs/CODING-RULES.md`](docs/CODING-RULES.md) always; [`docs/UI-PATTERNS.md`](docs/UI-PATTERNS.md) for any UI with tables, lists, or row editors; the area's spec under `docs/spec/` (the Documentation section below maps content to doc).
2. **Validate the request** against existing behavior in the specs; restate ambiguities and confirm before planning.
3. **Implement following the documented patterns.** Where docs and code disagree, trust the code and flag the discrepancy.

## Plans

Large work gets `docs/plans/<topic>.md` — goal, scope, out-of-scope, constraints, steps, and how the result will be verified. Backlog items that outgrow their entry graduate into a plan file. Plans capture the *thinking* so a future session can pick up mid-stream.

## Verification

Wisp has no automated test suite — verification is running the real thing:

- The frontend build must pass.
- `npm run check-imports` must pass after any backend file move or rename. The backend has no build step, so nothing else validates import paths — and a *dynamic* import only resolves when its code path runs, so a stale one boots fine and 500s a single route later.
- Drive the change in the local dev stack where the platform supports it; the Mac dev environment runs stubs (no libvirt/containerd), so host-level pages verify locally while manager paths verify on the Linux server. Component-level UI can be driven through a temporary Vite harness with canned fetch/SSE responses.
- A change is **done** only after something was actually run and observed — never claim success without running something, and say plainly what could not be verified in the current environment.

## Debugging

- Find the root cause before fixing. No symptom patches, no speculative try/catch, no timers to mask races.
- **Prove the failure mechanism before designing the fix.** Name the specific failure mode, then find the one-line check that proves it (journal tail while reproducing, a CLI probe, runtime state). If you can't articulate the check, you don't understand the bug yet — keep investigating. "Designing for both cases" usually means this step was skipped. When the user asks for manual validation, treat it as a real request — it usually catches a leap.
- **No stacked safety nets.** Fix the mechanism and trust events. One reconciler per legitimate concern is fine; layering a second polling/probing fallback for the same concern is clutter and will be asked to be removed. Fall back to polling only when a real failure mode demands it — and ask first.

## Scope

- Don't silently fix or refactor unrelated code mid-session: either it's in scope, or it goes to the backlog. The user can also ask to "add this to the backlog" directly.
- YAGNI: build what the request needs, nothing speculative.
- Match the existing patterns of the file being edited over personal preference.

## Documentation

Docs update **in the same edit** as the behavior they describe:

- `docs/spec/<AREA>.md` — the contract docs (API, UI, containers, auth, configuration, console, host monitoring, updates, backups, VM management, error handling…). Any change to behavior, APIs, UI, or configuration updates the matching spec.
- `docs/ARCHITECTURE.md` / `docs/TECH-STACK.md` — system overview and stack, when module boundaries or dependencies change.
- `docs/UI-PATTERNS.md` — the list/table/row-editor patterns; required reading for UI work and updated when a pattern changes.
- `CHANGELOG.md` — **update before every push**: new dated section at the top (`## YYYY-MM-DD`), entries grouped New Features / Bug Fixes, one terse intent-level line each; never touch older sections. When cutting a release, leave it uncommitted — `scripts/release.sh` folds it into the release commit.
- Audits land in `docs/review/`.

## Git

- Substantive changes: branch, commit there, `git merge --ff-only` into main, delete the branch. Trivial/docs-only changes commit directly to main. **No GitHub PRs — ever.**
- **Never push unless explicitly asked.** Plain `git push` goes to the `cala` remote (the day-to-day homelab git server); the `github` remote is releases only — it feeds the release workflow that builds the self-update tarball.
- Releases are batched — don't suggest cutting one after individual changes. The release flow is `scripts/release.sh` (version bumps + changelog fold + `v*` tag).

## Deployability

- Wisp is a **deployable application**. Fixes land in the app or its install/setup pipeline (`scripts/install.sh`, `scripts/setup-server.sh`, `scripts/linux/setup/`) so future installs work out of the box — never as manual server steps; manual fixes are for active debugging only.
- **Self-update is a first-class path** (`wisp-updater`: atomic-swap from GitHub Releases, re-runs helper install, re-templates the systemd unit). Changes touching the install layout, persisted state, privileged helpers, or systemd templates must keep the updater contract — [`docs/spec/UPDATES.md`](docs/spec/UPDATES.md) is the contract doc. The recurring traps: persisted files inside the install tree need the updater's preserve list; new privileged `wisp-*` helpers must be registered in `scripts/linux/setup/install-helpers.sh` or they vanish on the next self-update; the `wisp.service` template is re-applied from the repo on every update; only committed files ship in the release tarball.

## Feature-building mode (no migrations)

No automatic upgrade paths, no dual-read of deprecated keys or shapes, no legacy-cleanup code — **not even for artifacts produced earlier in the same session**. New behavior targets the current schema only; when replacing an approach leaves stale state on the server, state the manual cleanup clearly (one `rm`, one restart) instead of encoding it. Corrective repair of state the app itself wrote *wrong* is normal engineering, not migration. Replace with a real migration policy when the project graduates.

## Shell-exec allowlist

Prefer DBus/gRPC APIs over shelling out. Exec is permitted only for: `qemu-img`,
`cp --reflink=auto` (with `copyFile` fallback), `cloud-localds`/`genisoimage`,
`openssl passwd`, `xz`, `tar`, the privileged helpers `wisp-os-update`,
`wisp-mount`, `wisp-power`, `wisp-dmidecode`, `wisp-smartctl`, `wisp-nvram`,
`wisp-netns`, `wisp-cni`, `wisp-bridge`, `systemctl start wisp-updater.service`
(via `sudo -n`), and CNI plugins under `/opt/cni/bin/`. Build-time only: `git`
(noVNC vendoring). macOS dev stubs only: `system_profiler`, `vm_stat`, `sysctl`.

Anything else needs user validation first. New privileged `wisp-*` helpers must
be registered in `scripts/linux/setup/install-helpers.sh` and documented per the
checklist in [`docs/spec/DEPLOYMENT.md`](docs/spec/DEPLOYMENT.md).

## Kora duties

- When a change alters what wisp can do or how workloads deploy onto it — capabilities, app templates, container/networking model, API/auth surface, agent access, deployment flow — update the kora documents "Project: wisp — opinionated single-user KVM/QEMU + containerd manager" and "Deploying projects to the homelab (Wisp + zot registry)" in the same session.
- On shipping, settle the statuses of the backlog/idea notes involved (`completed` / `superseded`). Current status is inferred from the overview plus the active `wisp`-tagged notes — there is no hand-maintained status document.
- Reference the repo from kora documents per the kora skill "Working in a kora-driven project": stable named surfaces only, repo-root-relative; file-level paths only in backlog implementation sketches.
