# Wisp Project Audit — 2026-10-16

Full review of the codebase at `e4c6b14` (v2.3.0 + 2 docs commits), ~150 commits after the
2026-07-05 audit (`fcee00d`). Five parallel read-only reviewers, one per area (HTTP/auth/MCP,
VM manager + storage, containers + networking + mDNS, privileged helpers + install/update +
host monitoring, frontend), plus a dependency audit. The highest-severity findings were
re-verified by the main session; the verification column says how each finding was established.

Fix plan: [`PLAN-1-SECURITY.md`](PLAN-1-SECURITY.md) → [`PLAN-2-DATA-SAFETY.md`](PLAN-2-DATA-SAFETY.md)
→ [`PLAN-3-ROBUSTNESS.md`](PLAN-3-ROBUSTNESS.md) → [`PLAN-4-LOW-AND-DRIFT.md`](PLAN-4-LOW-AND-DRIFT.md).

> **Remediation status (2026-10-16).** Every finding is fixed, documented, backlogged or dropped
> below. Bundle names are the plan bundles (S/D/R/L); commits are on the `fix/audit-*` lineage
> (short hashes may change at integration). Linux verification per bundle: the PLAN files'
> Results sections. Backlog items live in [`docs/BACKLOG.md`](../../BACKLOG.md), each with its
> revisit trigger. User decisions taken while fixing are marked **decided**; the settled ones are
> recorded in the owning spec.
>
> | ID | Status | Where / note |
> |---|---|---|
> | A1 | fixed | S1 `c514909`; 404/SPA-shell path follow-up `c5ba165`. Follow-up [P5.1](PLAN-5-AUTH-AND-SECRETS.md) replaced the URL-based gate: each route declares its access level, undeclared = admin |
> | V1 | fixed | S2 `cba43ae`. **Decided:** clone/restore copy the stored `<graphics>` as-is (pre-fix VMs keep `0.0.0.0` until re-saved — VM-MANAGEMENT.md; manual fix in CHANGELOG) |
> | V2, A2 | fixed | S3 `265d0b9` |
> | V3, V4, V14 | fixed | D1 `31d0a9d`. **Decided:** refuse (409 `VM_DIR_EXISTS`); adopting kept disks → backlog |
> | V19 | fixed in V19 bundle (pending integration) | **Decided:** flatten each disk's backing chain into the backup (refusing rejected); `cloud-init.iso` no longer backed up, regenerated from `cloud-init.json` on restore; restore-in-place onto a VM with snapshots → 409 (also closes the stranded-snapshot-metadata item) |
> | C1 | fixed | D4 `6278b4f` |
> | A3 | fixed | S4 `954ad95`. **Decided:** refuse app-managed mount content for every caller (also `POST …/file`). **Superseded by P5.2** (PLAN-5): the read half of that app-only guard is replaced by generic secret file mounts — content GET refuses any secret file (user-flagged, or declared by the app module) with 403 `CONTAINER_MOUNT_SECRET`; non-secret app files are readable again; app-mount writes stay `APP_CONFIG_ONLY` |
> | A4 | fixed | R2 `fed52df` |
> | V5, V6, V7 | fixed | D2 `783c132`; rename/clone take the lock `4311219` |
> | V8, V10 | fixed | D3 `ee913b1` |
> | V9, P11 | fixed | D6 `fa11b46` |
> | V11, V15 | fixed | R3 `c0d3abd` |
> | C2 | fixed | R5 `c7afed0`; scheduled restart visible + stoppable `63a2147`. **Decided:** enforce (not remove); `always` and `unless-stopped` both stay (CONTAINERS.md) |
> | C3 | fixed | D4 `1142e01` |
> | C4 | fixed | R5 `d4977aa` |
> | P1, P12 | fixed | D5 `447b639` |
> | P2 | fixed | R4 `684a0a9` |
> | P3, P4 | fixed | R4 `056aa8c`. **Decided:** `NEEDRESTART_MODE=a` (auto-restart; HOST-MONITORING.md); Arch checks via a scratch dbpath |
> | F1, F2, F3 | fixed | R1 `b92222e`, `8a0013f`, `22f6a27`. **Decided:** top-level error boundary added |
> | A5–A8 | fixed | L2 `c5ba165`. **Decided:** A6 evicts the oldest pending start (AUTH.md) |
> | C17 | fixed | `7575782` |
> | V12, V16 | fixed | L4 `c9939ac`, `9e27f8e` |
> | V13 | fixed | S4 `f141b9a` (existing files: manual `chmod`, CHANGELOG) |
> | V17 | fixed | D6 `673cb29` (live reconnect not exercised on Linux — needs a dbus restart); boot-time connect failure → backlog |
> | V18 | documented + backlogged | `893d3b3` (BACKUPS.md § Not backed up); swtpm backup helper → backlog |
> | `VIR_DOMAIN_STATE_SHUTDOWN` | fixed | L4 `6410d35` (offline = shutoff only) |
> | Unconfirmed (VM) | resolved | live-snapshot overlays → V19; snapshot metadata after restore → V19 (409); `.mem` collisions fixed `3a43653`; HAOS xz race fixed `fa11b46` (+ `decompressing` phase `8ee125c`) |
> | C5–C8, C13, C15, C16, C18, `isKnownApp` | fixed | L5 `ab6df31` |
> | C11 | fixed | L5 `ab6df31`. **Decided:** ship Docker's default seccomp profile; per-container opt-out → backlog |
> | C9 | fixed | S4 `855bab7` |
> | C12 | fixed | R2 `59917bf`; FIFO I/O off the threadpool (R6, found while fixing) `f2af879`; console exec reaped before delete `aae4585` |
> | C14, O1 | fixed | L1 `fbe73b0`, `9e962b9`. **Decided:** forwarder answers the host's own name from the bridge and never returns link-local answers; avahi stall cause unexplained; avahi `deny-interfaces` → backlog |
> | Unconfirmed (containers) | resolved | entry-group leak (VM side) and rename DHCP lease → backlog; lifecycle lock → covered by C7's start-owned field merge; secrets in `APP_RELOAD_FAILED` detail → backlog |
> | P5, P6 | fixed | L6 `e30201b`, `67f9538` |
> | P7, P8 | fixed | S5 `72e0fa8` (2026-07-05 M3 now complete; `wisp-cni` conf constrained by owner check on the open fd). Residual `/mnt/wisp` race + netns arg → backlog |
> | P9, P10 | fixed | L6 `5184978` (updater fixes apply one update late; hosts whose group ≠ user re-run `install.sh` once) |
> | P13, P14, P15 | fixed | L6 `f30b00c`, `58824c1` |
> | Unconfirmed (install) | resolved | `container-dns.sh` EEXIST and RAPL fixed `67f9538`; staging realpath and `TimeoutStartSec` (TERM now rolls back) fixed `5184978`; Arch `[ignored]` fixed `056aa8c` |
> | F4–F10 | fixed | L3 `ebc0cd3`, `61c4234`, `f45bb52`, `358f2db`, `89fb439`, `5fa8bc3`, `f30d765` |
> | Unconfirmed (frontend) | resolved | Image Library ordering fixed `8a0013f`; `createSSE` retrying a 404 confirmed → backlog |
> | Found while fixing | fixed | app-container create's spurious job failure `ab6df31`; job SSE ended after the terminal event `7fb29da`; missing `/assets` 404 instead of the SPA shell `2295644`; SSE headers flushed at stream open (L7) |
> | Part 5 drift | fixed | L7 (`fix/l7-docs-drift`) where earlier bundles hadn't: CONSOLE.md cookie auth, UPDATES.md privilege boundary, UI-PATTERNS pill-row modal, CONTAINERS.md module table, SETTINGS/DEPLOYMENT `list`, stale comments, `window.prompt`, allowlist (`unzip`, `mkfifo`, `ip netns`; `bash` wrapper removed), dead fallbacks + `wisp-apt` + `migrate-app-containers.sh` removed, `check-imports` checks module-relative paths |
> | Leftovers noted while fixing | backlogged | VM restart flags, rename/clone edges, app-config Restart badge, app-container devices/mount routes, secret file modes, store action slot, change-password rate limit, update-install guard, upload race, and others — see BACKLOG.md |
> | Dropped | — | frontend reading `nostate` as stopped (harmless); clone of a paused VM (by design); `containerd.sh` apt prompts (setup is interactive); `wisp.service` `ExecStartPre` pipeline (fine); `docs/review/2026-07-05/` being gitignored (intentional: drafts stay private until triaged) |

## Summary

| Severity | Count | Headline |
|---|---|---|
| Critical | 1 | Auth bypass via percent-encoded path prefix (A1) |
| High | 5 | VNC on 0.0.0.0 without auth (V1); VM name `.` → `rm -rf vmsPath` (V2); re-create/clone/restore over kept VM dir (V3); tiny-samba share rename deletes data (C1); backup after a live snapshot misses the disk (V19, found during fixing) |
| Medium | 21 | Backup-root delete via `..`, secret read via read token, SSE/WS leaks, VM backup/restore integrity, stream-error crashes, mount detection, apt hang, frontend white-screen + stale state |
| Low | 40 | Hardening, UI annoyances, parsing edge cases, updater rollback scope, doc drift |
| Ops | 1 | Recurring `wisp.local` resolution failures inside containers (O1) |

Prior-audit status: L1, L2 (partially — see V13), M4, M5, M6, L8 intact. **M3 regressed to
partial** (P7). Still open as recorded: M1/M2 (login rate-limit hardening), M7 (unsigned
update tarball), H3, L3–L7, L9 — not re-reported here.

Verification legend: **main** = re-checked by the main session (code read and/or live probe);
**probe** = reviewer ran a throwaway probe against the real module; **code** = reviewer code
read only. Plan bundles re-confirm "code" items before fixing (CLAUDE.md § Debugging).

---

## Part 0 — Dependencies (✅ resolved 2026-10-16, `f937307`)

`npm audit` before: backend 8 (6 high — fastify ≤5.12.4 ×7 advisories, undici 8.0–8.10.1 ×11,
@grpc/grpc-js, @fastify/busboy, fast-uri, brace-expansion; moderate js-yaml, fast-copy);
frontend 4 (high source-map-js, dompurify IN_PLACE XSS ×2, moderate postcss-selector-parser).

Applied: lockfile-only `npm update` to current latest for every direct dependency (no range
changes). Backend → 0. Frontend → 1 moderate: `@tailwindcss/typography@0.5.20` (latest) pins
`postcss-selector-parser@6.0.10` exactly — build-time, parses our own CSS, unreachable;
recorded in `docs/TECH-STACK.md` with its recheck condition. Verified: frontend build,
`check-imports`, backend boot + login + 401 on unauth + SSE + multipart upload parse on darwin.
Not verified: containerd gRPC / libvirt paths with the new versions (Linux only).

Note: A1 is **not** a Fastify bug and is not fixed by the upgrade.

---

## Part 1 — Critical / High

**A1 — Auth bypass: percent-encoded `/api` / `/ws` prefix skips the auth hook** — Critical — main (live)
`backend/src/lib/auth.js:216` gates on raw `request.url.startsWith('/api'|'/ws')`; find-my-way
decodes `%61` → `a` before routing. `GET /%61pi/vms`, `/%61pi/settings`, `/%61pi/auth/tokens`
→ 200 unauthenticated (reproduced on the dev stack). `/%77s/...` reaches console/VNC WS handlers
with `user=null`; body-less POSTs are CORS-simple so a LAN web page can fire them blind. Bearer
branch's `/ws` refusal (`auth.js:173`) has the same flaw. Present at `fcee00d`; ships in v2.3.0.
`docs/spec/AUTH.md:68` overstates the percent-encoding protection.
*Remediation:* S1 keyed the gate on the matched route pattern; follow-up P5.1 removed URL-based
auth entirely — every route declares `config: { auth }`, one hook enforces it, undeclared = admin.

**V1 — VM VNC listens on `0.0.0.0` with no password** — High — main
`vmManagerCreate.js:224`, `vmManagerConfig.js:245` emit `listen='0.0.0.0'`, overriding libvirt's
localhost default. Any LAN host gets keyboard/mouse on any running VM via `host:5900+N`,
bypassing Wisp auth entirely. The console proxy only needs `127.0.0.1` (`routes/console.js:55`);
`CONSOLE.md:22` documents `127.0.0.1`. Existing domains keep the bad XML until re-saved.

**V2 — VM name `.` passes validation; clone rollback / delete-with-disks `rm -rf` the VMs root** — High — main
`lib/validation.js:6-27`, `vmManagerValidation.js:11-31` reject `..` substrings but allow `.`;
`getVMBasePath('.')` = `vmsPath`. Clone `newName: "."` failure rollback or delete-with-disks
removes every VM's files. Also: names validated trimmed but used untrimmed (`"web "`).
Same root as A2.

**V3 — Create / clone / restore-as-new write into a kept VM directory** — High — main
"Delete VM, keep disks" keeps `vms/<name>/`; `VM-MANAGEMENT.md:126` says re-create "picks them
up". Actually: createVM `mkdir -p` + `qemu-img create disk0.qcow2` overwrites the kept disk
(`vmManagerCreate.js:287-325`); cloud-init overwritten; clone copies over and on failure
`rm -rf`s the pre-existing dir (`:426-519`); restore overwrites (`vmManagerBackup.js:623-626`).
Rename already guards this (`vmManagerConfig.js:77-81`).

**V19 — VM backup after a live snapshot captures only the overlay, not the disk** — High — main (live, tini 2026-10-16)
A live snapshot (`<memory snapshot='external'>`, no `<disks>`) makes libvirt switch every disk to an
external overlay (`disk0.<snap>`), and the domain keeps pointing at it until the snapshot is
deleted. `createBackup` copies each disk's `<source>` only and never follows the backing chain.
Reproduced on tini: live snapshot of gubi → stop → backup reported success with
`disk0.ovtest.gz` = **463 bytes**; the 4 GB `disk0.qcow2` base was not in the backup (manifest lists
only `disk0.ovtest`). Restoring it yields an overlay whose backing file is an absolute path into the
original VM dir. `cloud-init.iso.gz` was also missing from that backup (not yet explained). Affects
v2.3.0. Fix options (decision): flatten each disk into the backup (`qemu-img convert` of the full
chain → gz, allowlisted tool), or refuse backup while any disk has a backing chain.

**C1 — Renaming or removing a tiny-samba share deletes its data** — High — main
Mount name is `share-<shareName>` (`containerApps/tinySamba.js:322`); `updateContainerConfig`
`rm -rf`s every local mount whose name left the list (`containerManagerConfig.js:201-211`).
Rename `photos`→`pictures` deletes `files/share-photos/` while smbd serves it; a reload
rollback restores the mount list but not the data. Remove has no confirm (`TinySambaAppSection.jsx:583`).

---

## Part 2 — Medium

### HTTP / auth
- **A2 — Backup delete accepts `.`/`..`; can `rm -rf` a backup root or SMB share root** — main.
  `routes/backups.js:40` `TIMESTAMP_REGEX` allows dots (comment at :36-39 wrongly says it blocks
  `..`); `{vmName:'.', timestamp:'..'}` resolves to `<root>`, accepted by the
  `resolvedBackup === resolvedRoot` branch (`vmManagerBackup.js:500`). Container variant wipes
  `<root>/containers`.
- **A3 — Read-scoped token reads plaintext app secrets via mount content** — main.
  `GET /containers/:name/mounts/:mountName/content` (`routes/containers.js:702`) returns
  tiny-samba `tiny-samba-passwords`, zot `session-keys`. Contradicts masking in
  `GET /containers/:name` and MCP.md's read-token promise.
- **A4 — SSE/WS close listeners attached after an `await` → leaks on early disconnect** — probe.
  `routes/events.js:112-130`, `vms.js:1016-1021`, `containers.js:563-566,607-617`,
  `console.js:38-93`, `containerConsole.js:66-127`. Leaks stats timer + 6 subscriptions per
  aborted `/api/events`; leaves exec shells/PTYs in containers.

### VM manager / storage
- **V4 — Create with an existing VM's name corrupts that VM's cloud-init** — code.
  `routes/vms.js:226-249`: `generateCloudInit` runs before the `VM_EXISTS` check, rollback deletes
  the live VM's ISO.
- **V5 — Failed VM backup leaves a listed-as-valid partial dir; in-place restore truncates live disks** — code.
  `vmManagerBackup.js:229-241` (no cleanup), `:380-387` (listing needs only `domain.xml`),
  `:69-90,546-554` (writes straight over live disks). BACKUPS.md claims partial dirs are removed.
- **V6 — In-place restore not locked against start/backup** — code. `routes/vms.js:308-352`,
  `vmManagerLifecycle.js:6-18`; UI gate only covers `BACKUP` kind (`OverviewPanel.jsx:100-112`).
- **V7 — Multi-destination VM backup reports `done` after the first destination** — code.
  Per-destination `{step:'done'}` (`vmManagerBackup.js:337`) forwarded by `routes/vms.js:329-335`;
  frontend treats it as terminal.
- **V8 — Editing a running VM reverts pending-restart edits** — main.
  `updateVMConfig` bases `DomainDefineXML` on live XML (`vmManagerConfig.js:30`,
  `getDomainXML` default flags 0) instead of inactive.
- **V9 — Image download crashes the backend on ENOSPC / EEXIST** — main + probe.
  `downloads/downloadUtils.js:47-73`: write-stream `error` listener attached only after the loop;
  no `uncaughtException` handler. Double-click "Ubuntu cloud image" can race to EEXIST.
- **V10 — "Add disk" can overwrite an existing disk file** — code. `vmManagerDisk.js:75-82`
  names `disk0`/`disk1.qcow2` and runs `qemu-img create` before any slot/file check;
  `routes/vms.js:646` has no slot enum.
- **V11 — One progress event per 64 KiB chunk, all retained** — code. `vmManagerBackup.js:52-58,259-265`,
  `downloadUtils.js:62-66`, `jobs/jobStore.js:96-107,170-183`. ~800k events per 50 GB disk,
  stored and replayed.

### Containers
- **C2 — `restartPolicy` stored/offered but never enforced** — main. Only consumers are the
  default, deploymentOverview and MCP; `/tasks/exit` just refreshes the list.
- **C3 — Delete-keep-files leaves a ghost container; recreate can wipe kept data** — main (create check).
  `container.json` kept → still listed, start fails, autostart retries; create checks only
  containerd (`containerManagerCreate.js:302-314`) and `rm -rf`s the dir on pull failure.
- **C4 — Background/MCP image-update checks never surface `updateAvailable`** — code.
  Digest refresh + cache notify live only in the REST route (`routes/containers.js:224-229`),
  not in `checkAllImagesForUpdates`.

### Install / helpers / host
- **P1 — `getMountStatus` reports mounted when any parent is a mount point** — main.
  `storage/linux/smbMount.js:239` prefix match. With `/mnt` mounted, shares under `/mnt/wisp/`
  never mount; backups land on local disk silently; boot orphan sweep can lazy-unmount
  `/mnt/wisp` itself (`mountsAutoMount.js:31`).
- **P2 — `containerd.sh` hardcodes Docker's Ubuntu repo** — code. Debian/Mint hosts: apt broken
  host-wide (`scripts/linux/setup/containerd.sh:43,50`).
- **P3 — `wisp-os-update upgrade` not non-interactive** — code. No `DEBIAN_FRONTEND`,
  `NEEDRESTART_MODE`, `--force-confdef/confold`; stdin open → hang → killed mid-dpkg
  (`backend/scripts/wisp-os-update:141-150`, `osUpdates.js:77,177`).
- **P4 — Arch: hourly `pacman -Sy` sets up partial upgrades** — code (`wisp-os-update:64,68`).

### Frontend
- **F1 — One stats error frame white-screens the app** — main. `store/statsStore.js:15` stores
  error frames; `HostStatsBar.jsx:35-57` dereferences; no error boundary anywhere.
- **F2 — Late config response for the previous workload overwrites the current one** — code.
  `vmStore.js:139-144,173-176`, `containerStore.js:150-155`; sibling `ContainerLogsSection.jsx:66-78`.
  Action buttons can act on the wrong VM.
- **F3 — Wrong current password in Change password logs every tab out** — main.
  `api/client.js:86-90` treats all 401s as session expiry; backend returns 401 for wrong current
  password (`routes/auth.js:130-135`).

---

## Part 3 — Low

### HTTP / auth
- **A5** — `GET /api/settings` response schema drops `mounts[].hasPassword` (`routes/settings.js:5-20`); saved-password indicator never shows.
- **A6** — Unauthenticated `/api/auth/oidc/login` flood fills the 1000-entry pending table → `OIDC_BUSY` for 10 min (`oidc.js:230-235`).
- **A7** — OIDC `redirect_uri` derived from raw `Host` header (`routes/auth.js:263-273`); harmless only if the IdP exact-matches (unconfirmed).
- **A8** — Schema-validation errors return Fastify's default shape, not `{error, detail}` (no `setErrorHandler`); frontend shows bare "Bad Request". ERROR-HANDLING.md drift.
- **C17** — Flat `env` in container PATCH accepted for non-app containers; spec promises 422 (`containerManagerConfig.js:222`, regression of the 4f652a8 guard).

### VM manager
- **V12** — fast-xml-parser `parseTagValue` mangles numeric-looking names (`007`→`7`) (`vmManagerXml.js:6-14`).
- **V13** — L2 incomplete: `cloud-init.json` (password hash) written 0644; `/tmp` temp dir default mode; restored ISO 0644 (`cloudInit.js:72-74,241-245`, `vmManagerBackup.js:81-85,563`).
- **V14** — Create / restore-as-new leave half-made VMs on failure (`vmManagerCreate.js:303-325`, `vmManagerBackup.js:609-660`).
- **V15** — Job-store expiry: single timer, age from `createdAt` → long jobs evicted right after completion (`jobs/jobStore.js:155-166`).
- **V16** — Negative CPU % after VM restart: `prevVMStats` keyed by name, deleted by path (`vmManagerConnection.js:101-103`).
- **V17** — `setTimeout(connect)` reconnect rejection unhandled → crash instead of retry (`vmManagerConnection.js:117-125`).
- **V18** — Backups omit vTPM (swtpm) state; Win11 template enables vTPM.
- Unconfirmed (verify on Linux): live snapshot external overlays vs backups; stranded snapshot metadata after in-place restore; snapshot `.mem` filename collisions; HAOS xz exit/finish race (`downloadHaos.js:58-67`).

### Containers / networking / mDNS
- **C5** — `publishContainer` ignores `localDns` and running state; stale address published after rename (`containerMdnsReconciler.js:94-103`).
- **C6** — Reconciler race (un-awaited handlers) leaves a crashed container published (`:41-68`).
- **C7** — Start clobbers config edits made during the DHCP wait (`containerManagerCreate.js:494-503,587,603`).
- **C8** — Storage-mount symlink-escape check precedes the network wait; spec uses unresolved path; `mkdir -p` before check (`containerManagerSpec.js:94`, `containerManagerMounts.js:336-354`).
- **C9** — Restore trusts archive `container.json` (devices `/dev/mem` via `gpu` type, mount name `../..`) (`containerManagerBackup.js:536-549,629-661`).
- **C11** — No seccomp profile / user namespace in the OCI spec (`containerManagerSpec.js:192-229`). Hardening.
- **C12** — `execCommandInContainer` leaks the process + FIFO streams on timeout (`containerManagerExec.js:287-331`).
- **C13** — Image ref normalisation treats only dotted hosts as registries (`nas:5000/x`, `localhost/x`, local `myapp:v1` delete) (`containerImageRef.js:5-10`).
- **C14** — DNS forwarder relays TCP queries over UDP; upstream UDP socket not `connect()`ed (`mdns/linux/forwarder.js:333-351,401`).
- **C15** — Log view reads the whole run log to tail 500 lines (`containerManagerLogs.js:140-156`).
- **C16** — Failed start after network setup leaves mDNS services published (`containerManagerCreate.js:593-613`).
- **C18** — Rule drift: `runScheduledBackups` not exported (CODING-RULES §7); `managedBridges.js` imports app glue + both managers.
- Trivial: `isKnownApp` uses `in` (`app: "constructor"`) (`appRegistry.js:63-65`).
- Unconfirmed: avahi entry-group leak on overlapping `registerAddress`; DHCP lease not released on rename; no per-container lifecycle lock; token text in `APP_RELOAD_FAILED` detail.

### Install / helpers / host monitoring
- **P5** — `backup-status.json` path one `../` short → lives under `backend/config/`, deleted on every self-update (`backupStatus.js:24`) — main.
- **P6** — Fresh `install.sh` skips `container-dns.sh` (br0 guard) and never re-runs it.
- **P7** — M3 partial: `wisp-cni` bin dir (arg 6) unpinned → arbitrary root exec (`backend/scripts/wisp-cni:12,18,24-30`). (= containers review C10.)
- **P8** — `wisp-mount` unmount/rmdir accept any path; TOCTOU between realpath check and mount.
- **P9** — Updater rollback restores the tree only, not helpers/sudoers/units (`wisp-updater:59-67`).
- **P10** — Updater `chown $USER:$USER` assumes a same-named group (`wisp-updater:63,81`).
- **P11** — Update download crashes the backend on write error (same class as V9) (`wispUpdate.js:297-318`) — main.
- **P12** — `/proc/mounts` octal escapes (`\040`) not decoded (3 parsers).
- **P13** — Host net throughput double-counted (bridge + uplink + vnet/veth) (`procStats.js:454-464`).
- **P14** — Filesystem "available" uses `bfree` not `bavail` (`hostHardware.js:238`).
- **P15** — SMART reads wake spun-down disks (no `-n standby`) (`wisp-smartctl:32`).
- Unconfirmed: `container-dns.sh:151-156` EEXIST race under `set -e`; `rapl.sh` setfacl lost on reboot; `wisp-updater:35` staging prefix not realpath'd; `TimeoutStartSec=600` vs slow `npm ci`; Arch `[ignored]` packages counted.

### Frontend
- **F4** — Logout with SSO enabled re-logs-in immediately (`TopBar.jsx:17-20` → `Login.jsx:38-41`).
- **F5** — Drag-select ending on the backdrop closes the modal (`Modal.jsx:69-81`).
- **F6** — Clearing a stored secret's field after typing saves `''` (`EnvVarEditorModal.jsx:54,198`).
- **F7** — Background create completion navigates away from wherever the user is (`CreateVMPanel.jsx:217-223`, `CreateContainerPanel.jsx:80-86`).
- **F8** — Consoles auto-reconnect after manual Disconnect (`VNCConsole.jsx:289-299`, `ContainerConsole.jsx:291-303`).
- **F9** — SMB Test connection sends blank password after a share-path edit (`SmbShareEditorModal.jsx:78-93`).
- **F10** — Finished job rows can linger (prune not rescheduled) (`backgroundJobsStore.js:48-63`).
- Unconfirmed: `ImageLibrary.jsx:332-357` filter responses out of order; `createSSE` retrying forever on 404.

---

## Part 4 — Ops finding

**O1 — `wisp.local` intermittently unresolvable inside containers** — evidence from canapana's log.
282 `lookup wisp.local on 169.254.53.53:53: no such host` errors since 2026-10-03, ~50 bursts
(e.g. 10-13 14:08, 10-14 09:47, 10-14 17:29 UTC), hitting `/mcp` and `/api/events`. Every other
Caddy upstream is a Wisp-published workload answered by the forwarder's fast path
(`lookupLocalEntry`); `wisp.local` is the host's own name and takes the avahi DBus slow path
(1.5 s cap → NODATA). Right after boot (10-03 10:31) avahi returned a link-local
`fe80::…` AAAA, which the forwarder passed through unfiltered (`connect: invalid argument`).
Root cause of the avahi stalls **not yet proven** — needs `journalctl -u avahi-daemon -u wisp`
around the burst times.

---

## Part 5 — Doc drift, rule drift, dead code

- `docs/spec/AUTH.md:68` percent-encoding claim (A1); `AUTH.md` lists `/login?sso=disabled` but `Login.jsx` has no notice for it.
- `docs/spec/CONSOLE.md` §Architecture/§Authentication still documents `?token=<jwt>` query auth.
- `docs/spec/BACKUPS.md`: partial-dir cleanup claim (V5); "restores run as background jobs" (restore-as-new is synchronous); `backup-status.json` path (P5, also `UPDATES.md:18`).
- `docs/spec/VM-MANAGEMENT.md:126` "re-create picks them up" (V3).
- `docs/spec/CONTAINERS.md`: restartPolicy (C2), update badge (C4, :412), env rejection (C17, also `API.md:1589`), service publish ordering (C16), stale line refs (:25), module table names `lib/containerManager.js`.
- `docs/spec/DEPLOYMENT.md:115` old br0-stub design; `:321` says `apt-get upgrade` (code: `dist-upgrade`).
- `docs/spec/UPDATES.md` privilege model overstates the boundary (updater runs deploy-owned scripts as root).
- `docs/UI-PATTERNS.md` lists ContainerNetworkSection as disclosure strip; it now uses a Modal.
- Stale comments: `containerManagerNetwork.js:491-513`, `container-dns.sh:52`, `wisp-nvram:14-15`, `vmMdnsReconciler.js` header, `vmManagerNetwork.probeAndEmit`, `libvirtConstants.js` (`VIR_DOMAIN_STATE_SHUTDOWN = 0` is NOSTATE), `routes/backups.js:36-39`.
- Shell-exec allowlist drift (CLAUDE.md): `unzip`, `mkfifo`, `ip netns` fallback, `bash` (`smart.js:208`) are executed but not listed.
- Dead / broken: bundled-script fallbacks resolve to non-existent `lib/scripts/` (`containerManagerNetwork.js:55`, `managedBridges.js:24`); `backend/scripts/wisp-apt` unreferenced; one-shot `scripts/migrate-app-containers.sh` still ships; `check-imports.mjs` can't see `__dirname` data paths (would have caught P5).
- `ContainerLogsSection.jsx:172` uses `window.prompt` (predates last audit).

## What's notably done well

Pinned-HS256 JWT; constant-time comparisons; hashed API tokens never returned; MCP admin tools
re-mask output; OIDC with state + nonce + PKCE + full JWKS checks; `0600` atomic config writes
under one lock; SSRF-pinned fetch with redirect re-validation; domain XML built via
fast-xml-parser with entity-escaped attributes; backup paths server-built and realpath-confined;
consistent CSRF double-submit; DOMPurify on release notes; no CDN assets; thorough
`wisp-bridge`/`wisp-netns` validation; atomic helper installs.
