# Wisp Re-review — 2026-10-16 (after v2.4.0)

Second full review the same day, run on `main` at v2.4.0 (`72b2e44`) after the audit fixes,
Plan 5 and state migrations shipped. Same five areas, briefed as a fresh review (no skip lists).
One reviewer (VM/storage) read the earlier audit and backlog anyway and left out items already
tracked there; the other four reviewed from scratch. Highest-severity items were re-checked by the
main session (✔ main).

Dependencies: backend 0 vulnerabilities; frontend only the known `@tailwindcss/typography`
moderate (0.5.20 still pins `postcss-selector-parser@6.0.10`, recorded in TECH-STACK.md). Minor
updates available: `js-yaml` 5.5.0, `lucide-react` 1.58.0.

## Summary

| | Morning audit | This re-review |
|---|---|---|
| Critical | 1 | 0 |
| High | 4 (+1 found while fixing) | 2 |
| Medium | 21 | 15 |
| Low | 40 | ~35 |

None of the morning's findings came back. The new findings are mostly deeper corners the first
pass didn't reach (clone, VM restore validation, firmware edits, log streaming, container
concurrency) plus a few in code written today (marked **new code**).

---

## High

**V1 — Cloning a cloud-init VM that has booted fails** — ✔ main (tini: `cloud-init.iso` is
`libvirt-qemu:kvm 600`, unreadable by the deploy user). `cloneVM` copies every disk/CD-ROM in the
VM dir including the ISO → `cp`/`copyFile` EACCES → clone fails. Fix: don't copy the ISO; rebuild it
from `cloud-init.json` via a `populateVMDir` hook, as restore does (also gives the clone a fresh
instance id and its new MAC). `vmManagerCreate.js:502-524`.

**V2 — Cloning a VM with a live-snapshot overlay copies only the overlay** — ✔ main (no
backing-chain check in `cloneVM`). The clone stays layered on the source's base disk; deleting the
source's snapshot (commits into the base) or the source itself breaks it. Sibling of V19, which was
fixed for backups only. Fix: flatten via `getBackingChain` + `copyAndConvert`, or refuse with
`VM_HAS_SNAPSHOTS`.

## Medium

- **A1** — An admin API token can retarget OIDC (`PATCH /api/settings {oidc}` is `admin`) to an
  attacker IdP and log in, getting a full session (consoles, tokens, password) that survives token
  revocation; retargeting `issuer` also sends the stored client secret there. ✔ main. Fix: OIDC
  config edits session-only; require the secret again when `issuer` changes.
- **V3** — VM restore defines the backup's `domain.xml` without validation (CD-ROM/NVRAM paths
  outside the VM dir, `lun` disks, `<hostdev>`, `<filesystem>`, `<qemu:commandline>` kept; payload
  symlinks followed). Container restores got this validation (C9); VM restores didn't.
- **V4** — Library images converted without a backing-file/extent check (`qemu-img convert` merges
  a crafted qcow2's `backing_file` or vmdk extents — host files — into the new disk); resize/info
  probe the format.
- **V5** — The per-VM operation lock doesn't cover disk attach/detach/resize/bus, snapshot
  create/delete/revert, non-rename PATCH or cloud-init edits; rename's target-dir check races.
- **V6** — Firmware edit drops `<loader>`/`<nvram>` (EFI vars lost, NVRAM moves outside the VM dir)
  and `uefi` vs `uefi-secure` produce identical XML.
- **C1** — `container.json` (secret env values e.g. Caddy's Cloudflare token, tiny-samba passwords,
  zot OIDC secret) and container backup archives are world-readable. ✔ main (wisp: 644 in a 755
  dir, token in plaintext). Fix: write 0600 / dirs 0700; a migration for existing files.
- **C2** — Container operations aren't serialized per container (no equivalent of the VM lock): a
  user Start during a restart-policy start runs two starts that tear each other's netns/snapshot
  down; also start during restore-in-place, rename/delete during backup, concurrent app saves.
- **C3** — Live container log stream duplicates and drops lines (two unguarded `readNew` callers;
  offset set late). Harness: 2000 lines → 2553 delivered.
- **C4** — A short image ref saved via PATCH/MCP (`nginx:1.27`) makes every start fail with a
  misleading 404 (pulled under the normalized name, looked up by the literal one); MCP
  `update_container_image` leaves the service down.
- **P1** — The updater reports `step:done` once `systemctl start` forks; a release whose backend
  crash-loops at boot is never rolled back.
- **P2** — The OS upgrade runs inside `wisp.service`'s cgroup: a Wisp self-update, a crash or the
  600 s timeout kills dpkg mid-run.
- **P3** (**new code**) — Migrations are recorded `ok` when libvirt is unreachable: `connectManagers`
  only warns and `listVMs()` returns `[]`, so `0002` "succeeds" with no changes and never re-runs.
  ✔ main. Fix: `listVMs` throws `NO_CONNECTION` when not connected (runner mode at least), and
  surface per-domain fetch failures.
- **P4** — Host CPU % double-counts guest time (`guest`/`guest_nice` already inside `user`/`nice`):
  overstated exactly when VMs are busy. ✔ main. Fix: sum the first 8 fields.
- **F1** — Container console reconnect counter is reset on every attempt (`connect()` and on open),
  so a failing exec retries every second forever, "session expired" never shows, and `exit` spawns
  a new shell. ✔ main.
- **F3** — Container command edit splits on whitespace: quoted arguments break, and an API-set
  command with quoted args is silently changed on the next UI save. ✔ main.

## Low (by area)

- **HTTP/auth:** A2 stored SMB password reusable against a changed share host (hash leak); A3 read
  token can trigger privileged `apt-get update` refresh (and block upgrades); A4 change-password
  not rate-limited; A5 `setPassword` trims but login doesn't, non-atomic write; A6 changing
  `vmsPath`/`containersPath` splits glue vs managers until restart; A7 library upload
  check-then-write race; A8 spec drift on login without a password file.
- **VM/storage:** V7 legacy-layout backup delete can wipe all of a VM's backups (`{vmName:'vms'}`,
  confirmed by probe); V8 cloud-init PUT for a nonexistent VM creates its dir; V9 API create with a
  cloud-init template default builds an unstartable VM; V10 manifest `vmBasePath` realpath'd but XML
  paths not; V11 NIC/video/graphics edits rebuild elements (guest NIC renames); V12 library in-use
  check fails open when libvirt is down; V13 restore-as-new doesn't refresh the VM list cache.
- **Containers/net:** C5 mDNS services outlive a crashed container; C6 network probe can overwrite
  a concurrent config save; C7 mount-file paths follow symlinks at `files/<name>` (restored
  archives); C8 app-managed write guard misses zip/init/data-delete/row add-remove; C9 Caddy
  `domain`/`email` unvalidated in the Caddyfile; C10 VM and container with the same name share one
  mDNS entry; C11 console exec without `noNewPrivileges`; C12 `/proc` fib_trie parser never
  matches; C13 POST /containers persists unvalidated env/services/metadata; C14 rename skips CNI
  DEL; C15 restore leftovers not swept, dot-dirs listed as containers.
- **Helpers/update/host:** P5 (**new code**) `migrate.mjs` ignores `WISP_CONFIG_PATH` from
  runtime.env (import order); P6 RAPL wraparound at 2^32 (negative watts); P7 disk UUID not
  validated, mounts lack `nosuid,nodev`; P8 `wisp-cni` netns path unconstrained, `wisp-nvram`
  check/use race; P9 `unzip`/`mkfifo`/`ip netns` still flagged against the allowlist (they *are*
  listed now — reviewer read an older section; no action); P10 concurrent update installs share
  staging; P11 SMART helper errors shown raw; P12 Arch reboot-required with two kernel flavours;
  P13 multi-socket core/thread count halved; P14 CPU/disk/net delta state shared by every consumer;
  P15 (**new code**) `--dry-run` not side-effect free.
- **Frontend:** F2 job stream 404 leaves Create buttons / image check stuck; F4 host power errors
  swallowed; F5 renaming a stored secret env var without a value empties it; F6 mount file editor
  late-response race (can save another mount's content); F7 action state leaks across workloads;
  F8 Image Library refresh with stale filter; F9 drag-to-section errors unhandled; F10 one stream
  per running job can exhaust HTTP/1.1 connections; F11 Backups panel conflates same-named VM and
  container.

## Unconfirmed (to check on Linux)

Admin can mount the host root disk via `POST /host/mounts {type:disk, uuid}` (admin ≈ host root —
document or restrict); IPv6 SSRF gap for `::7f00:1`; clone keeps the source's cloud-init instance
id / MAC (no network); cloud-init edit on a running VM may leave QEMU on the deleted ISO inode;
`attachISO` on `sda`; libvirt relabelling a crafted backing file on attach; untagged image refs
failing to pull; user env vs image env precedence; zip extraction through symlink entries; DHCP
lease identity; avahi group orphan on concurrent re-register; no gRPC deadlines; `.local` HTTPS/SVCB
NXDOMAIN caching; Debian download size always 0; dmidecode empty-slot carry-over; usbMonitor
re-added bus; sign-out races with SSO; restart badges cleared by unrelated refreshes; tiny-samba
user rename dropping share access.

## Spec drift

ERROR-HANDLING auth-failure messages and NO_PASSWORD_CONFIGURED; MCP `toolError` lacks REST's
path redaction; CUSTOM-APPS app-mount write refusal scope (C8); UPDATES.md `NO_CONNECTION`,
`WISP_CONFIG_PATH`, `--dry-run` claims (P3, P5, P15) and rollback restoring in-tree config while
keeping the ledger (warn migration authors); VM-MANAGEMENT clone step copying the ISO (V1) and NVRAM
location (V6); BACKUPS archive validation containers-only (V3); CONTAINERS service deregistration
(C5) and fib_trie preference (C12); CONSOLE close-code 4000/4001 handling; API.md "bounded" scoped
streams (F10); HOST-MONITORING RAPL path; DEPLOYMENT `wisp-nvram` path; DISCOVERY SRV target after
avahi rename.

## Suggested next batch

1. **Security/data first:** C1 (+ migration for existing `container.json` and backups), A1, V3, V4.
2. **Broken features:** V1, V2 (clone), F1 (console loop), F3 (command editing), C3 (log stream),
   C4 (short image refs).
3. **Correctness of today's code:** P3 (migration false-ok — affects stable hosts updating while
   libvirt is down), P5, P15.
4. **Concurrency:** C2 (container op lock), V5 (VM lock coverage).
5. **Update safety:** P1 (health-gated start + rollback), P2 (OS upgrade out of the service cgroup —
   new privileged pattern, needs sign-off).
6. Then the Lows by area, and the dependency minors.
