# Overnight notes (for morning review)

## Decisions for the user
- S2/V1: clone + restore copy the stored <graphics> unchanged → cloning a pre-fix VM or restoring a pre-fix backup brings back listen=0.0.0.0. Left as-is (no-legacy-cleanup rule; respects deliberate virsh edits). Option: force 127.0.0.1 on clone/restore.
- S4/A3: also guarded POST …/file (overwrites the same file) — beyond brief.
- S5/P7: wisp-cni config file constrained by owner check on the open fd (SUDO_UID), not a path pin — differs from plan wording.

- D1/V3: refusing means reusing a kept disk needs the shell (move into the image library) — create form only lists library images. "Adopt kept disks" UI → backlog if wanted.
- D2: restore-in-place swaps files then defines domain last (per plan); if define fails, disks are restored but old definition stays (error says so). Leftover .restore-<uuid> after a crash is not auto-cleaned (documented safe to delete).
- D6: same-name concurrent downloads → `x` and `x (1)` (not an error).
- D6/V17: real reconnect test needs `sudo systemctl restart dbus` (disruptive) — user's call.
- R4/P3: NEEDRESTART_MODE=a (per plan) may auto-restart services incl. wisp itself if node is upgraded (helper killed after dpkg completes, request errors). Alternative `l` = list only, never restart. Recommend `l`.
- R5/C2: default unless-stopped → after ship any running container that exits on its own (incl. one-shot commands) restarts with backoff. 'always' ≡ 'unless-stopped' in Wisp (boot = autostart only) — collapse in UI/MCP? Missed exits while wisp down are not replayed (no polling, per rules).

- L2/A7: Advertised URL field in App Config now editable even with discovery off (it drives the SSO redirect URI); OIDC settings shows backend's redirect URI.
- L2/A6: chose evicting oldest pending OIDC start over per-IP limit (shared failed-auth budget would hurt password login).
- L4 (pending Linux confirm): live snapshots likely create external disk overlays → backups copy only the overlay (points at absolute base) = incomplete backup. Options: refuse backup when a disk has a backing chain, or flatten via qemu-img convert. Restore-in-place leaves stale libvirt snapshot metadata (snapshots after the backup listed but data gone) → option: 409 when VM has snapshots.
- L4: offline rule now = shutoff (5) only (state 4 'shutting down' no longer counts as offline).
- L6: updater changes (rollback host-setup, chown group, staging realpath, TERM trap) take effect one update late (old updater runs the update that ships them). Hosts whose group ≠ username fail every self-update today incl. the fixing one → re-run install.sh once. rapl.sh not in common-steps → existing installs get the RAPL fix only if re-run. backend/config/backup-status.json: no rm needed (swap deletes it); last-attempt cache starts empty once.

## canapana / wisp.local (O1) — findings + options
Proven: only wisp.local fails; it's the only Caddy upstream on the forwarder's avahi slow path (host's own name). Fast-path names never fail; homeassistant.local (slow path, LAN peer) never fails DNS. Steady state fine (300 parallel OK ~25ms; 8 cold-cache OK). Host silent at burst times. Not Mac sleep/display. AAAA = random veth fe80 (avahi publishes host name on every veth/vnet), unusable; wisp listens IPv4 only.
Not proven: why avahi stalls. Overnight watcher running (task bhengxuw6).
Options (keep wisp.local / mDNS): 1) forwarder answers host's own name from br0 addresses (recommended); 2) never return link-local answers (pairs with 1); 3) avahi deny-interfaces=veth*,vnet* (host-wide hygiene); 4) raise 1.5s cap (not recommended).

## Backlog candidates surfaced
- S1: setNotFoundHandler / applyShellCachePolicy branch on raw URL → encoded unmatched path gets SPA shell not JSON 404 (not security).
- S2: Graphics change on running VM doesn't set requiresRestart (vmManagerConfig.js:244); graphicsType accepts any string (routes/vms.js:118,586).
- S4: CUSTOM-APPS says {devices} on app container rejected; code only rejects alongside appConfig. Mount CRUD on app containers unguarded (/mounts POST/PATCH/DELETE, /zip, /init, DELETE …/data). App secret files written default mode under files/. Backup cloud-init.iso.gz default mode.
- S5: /mnt/wisp deploy-writable 0775 → mount TOCTOU not fully closable; wisp-cni netns arg only ^/ (could target host netns → network disruption).
- D1: rename's target-dir guard still 422 CONFIG_ERROR (not 409 VM_DIR_EXISTS); clone's cloud-init.json copy after define can leave a defined clone on failure.
- D3: NIC/video edits not flagged requiresRestart; ISO attach/eject on paused VM is config-only; cloneVM allows paused source; UI can't add sda disk to a disk-less VM.
- D4: pendingRestart stays true after APP_RELOAD_FAILED rollback; updateContainerMount returns requiresRestart:null w/o task; Local→storage share switch leaves files/share-<n> orphan.
- D5: disk mountedAt = first mount point (desktop automount elsewhere → shows unmounted).
- D6: libvirt connect failure at boot never retries; /api/updates/install no in-flight guard; library upload access()-then-write race (no crash); HAOS 'decompressing' phase never emitted (spec says it is).
- R4: SETTINGS.md:113 says Check runs `check`, backend runs `list`; containerd.sh's own apt install not noninteractive (setup is interactive, fine); custom pacman DBPath not followed.
- R1: vmStore/containerStore withAction share one actionLoading/error slot → action on A still running disables B's buttons / shows A's error on B. change-password wrong attempts not rate-limited (needs session). Dev backend listens on all interfaces.
- R2: interactive execInContainer failed-Start leak → R6. mkfifo not on allowlist (L7).
- R3: VM/container create managers still emit their own 'done' before job completes (check createAppContainer); container backup dir not exclusive (same-second collision); clone not shown busy on source in UI (409 covers); backup 'done' event carries absolute server path (undocumented).
- R6: interactive cleanupSession Kill→DeleteProcess without waiting for exit → runc shim may refuse, stopped exec entries pile up until task delete (revisit if `ctr tasks ps` shows buildup).
- L2: (worth fixing soon) unmatched /assets/<missing>.js in prod serves SPA HTML with Cache-Control immutable 1y → stale chunk after self-update could pin HTML. API.md:1609 envPatch requiresRestart wording. applyAppConfig first write includes mounts → pendingRestart set even when live reload succeeds. FST_ERR_BAD_URL bypasses setErrorHandler.
- L4: frontend treats nostate as stopped (backend: shutoff only) — harmless; cloneVM allows paused VMs by design; parser isArray 'serial' matches disk <serial>.
- L6: hwmon temp reads every 5s may wake disks if drivetemp loaded; wisp.service ExecStartPre ip|grep pipeline (fine).
- (moved into Phase 3 R3) container multi-destination backup 'done' bug; VM rename/clone not under the operation lock.
- docs/review/2026-07-05/ is gitignored (.gitignore:18) — intentional? AUDIT refs it.

## Manual cleanup (in CHANGELOG)
- V1 existing VMs: virsh edit or Graphics SPICE→VNC; find: for v in $(virsh list --all --name); do virsh dumpxml --inactive $v | grep -q "listen='0.0.0.0'" && echo $v; done
- V13: chmod 600 /var/lib/wisp/vms/*/cloud-init.json

## Verified
- Deps on Linux (tini via real updater): login, vms, containers, SSE topics, caddo start→IP→stop.
- Phase 1 darwin (agents): S1 encoded bypasses 401 etc; S2 XML probes; S3 validators/422s/delete guards; S4 unit+restore tamper probes; S5 helper refusals + function harness.
- Phase 1 integrated: check-imports OK, frontend build OK.

## Phase status
- Phase 1: fix/audit-phase1 — verified darwin + tini. Results recorded in PLAN-1.
- Phase 2: fix/audit-phase2 (on phase1) — integrated (2 doc conflicts resolved, merged code reviewed), deployed to tini; tini verification agent running.
- Phase 3: R1–R5 done+approved; R6 (FIFO threadpool, found by R2) done, Linux harness PASS (EOF works on Linux), on phase3. Phase 3 tini verifier running (deployed 8b4fba3, pre-R6). Phase 4 L2–L6 running; L7 after; L1 (DNS) waits for user's option choice.

## tini state to restore
- Password original at ~/wisp-password.orig-claude → restore to /opt/wisp/config/wisp-password at end.
