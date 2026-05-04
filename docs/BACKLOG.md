# Backlog

Issues, improvements, and tech debt identified but deferred. Pick up when prioritized.

## How to use this file

Each entry has:
- a short title (used as a header)
- **Found:** date and context
- **Symptom:** what users see (or don't see, for silent bugs)
- **Root cause:** what we know
- **Fix sketch:** the rough plan, not a binding design
- **Why deferred:** the reason it isn't shipping today

When an entry grows beyond a few paragraphs — multiple options to weigh, design tradeoffs,
phased plan — graduate it to `docs/plans/<topic>.md` and replace this entry with a one-line
pointer. Keep this file scannable.

---

## Bugs

### NVRAM file ops blocked by EACCES — UEFI VM clone fails; backup/restore silently lose NVRAM state

**Found:** 2026-05-03, while spot-testing step 3 of the modules-boundaries refactor (`a0bb5a8`).

**Symptom:**
- **Clone**: throws `EACCES: permission denied, copyfile '/var/lib/wisp/vms/<src>/VARS.fd' -> '/var/lib/wisp/vms/<dst>/VARS.fd'`. Visible failure, user sees the error.
- **Backup**: completes "successfully" but the resulting backup directory does not contain `VARS.fd`. Silent.
- **Restore**: completes "successfully", VM boots — but UEFI variable state (boot order, Secure Boot enrolled keys, custom NVRAM settings) has been **template-filled fresh** by libvirt because the backup had no NVRAM to restore. For most Linux VMs the loss is invisible; for Secure-Boot-enrolled Windows or custom-boot-order setups, it would be a real problem.

**Root cause:**
- libvirt creates `VARS.fd` as `libvirt-qemu:kvm` mode `600`. The Wisp deploy user is in `kvm` group but mode `600` only grants the owner read access — group membership doesn't help.
- `vmManagerCreate.js:479` (clone) uses `node:fs/promises` `copyFile`, which fails with EACCES.
- `vmManagerBackup.js:262` (backup) and `:494` (restore) wrap their NVRAM copies in `try/catch` blocks that **swallow all errors** with the comment "NVRAM file missing — VM may not use UEFI vars on disk." The comment conflates `ENOENT` (legitimate, BIOS-only VM) with `EACCES` (the actual bug). Result: backup and restore silently drop NVRAM state for any UEFI VM.

**Fix sketch:**
1. New privileged helper `backend/scripts/wisp-nvram` (pattern matches `wisp-mount`, `wisp-bridge`, `wisp-cni`). Signature: `wisp-nvram copy <src> <dst>`. Validates both paths sit under one of `/var/lib/wisp/vms/`, `/var/lib/wisp/backups/`, or the configured backup destination from `wisp-config.json`. Refuses anything else. `cp -p`, then chowns the destination to the deploy user (libvirt's `dynamic_ownership=1` takes ownership back on next VM start).
2. Register helper in `scripts/linux/setup/install-helpers.sh` (auto-installs on every self-update via wisp-updater's existing `install-helpers` step).
3. Replace the three `copyFile`/`copyWithProgress` NVRAM call sites with `execFile('sudo', ['-n', 'wisp-nvram', 'copy', src, dst])` — clone, backup, restore.
4. Fix the silent `try/catch` in backup/restore: distinguish `ENOENT` (legitimate skip, no log) from anything else (warn loudly or fail).
5. Doc updates: WISP-RULES shell-exec allowlist, DEPLOYMENT helpers table, VM-MANAGEMENT spec note.

**Spot test after fix:**
1. Clone a UEFI VM — should now succeed.
2. Backup a UEFI VM — `ls <backup-dir>` should show `VARS.fd` (or `tar -tzf data.tar.gz | grep VARS.fd` if the format changes).
3. Set a custom UEFI boot order in the source VM, backup, restore under a new name, boot — boot order should persist (today it would be reset).

**Why deferred:** Real silent-data-loss bug, but out of scope of the modules-boundaries refactor. Worth a focused `fix(vm)` commit when there's bandwidth.

---

## Improvements

### `wisp-os-update upgrade` uses `apt-get upgrade -y` — packages requiring new deps stay kept-back

**Found:** 2026-05-04, during osUpdate apt-path review.

**Symptom:** After clicking Upgrade in the UI, some upgradable packages remain in the next "View packages" list. They are kept back because `apt-get upgrade` (without `dist-upgrade`/`full-upgrade`) refuses to install or remove packages to satisfy new dependencies. On stable Debian/Ubuntu this is rare; on rolling/HWE/kernel-meta updates it's common (e.g. `linux-generic` jumps to a new kernel package name).

**Root cause:** `backend/scripts/wisp-os-update` (debian branch, `upgrade` action) runs `apt-get upgrade -y`. Conservative by design but mismatches what users expect from a "Upgrade" button — they assume "apply everything" semantics.

**Fix sketch:**
1. Switch the debian `upgrade` branch to `apt-get dist-upgrade -y` (alias `full-upgrade`). Same lock-detection wrapper pattern already in place.
2. Confirm the simulated count from `apt-get -s upgrade` (used by the `check`/`list` actions) still matches what `dist-upgrade` will install — it likely won't for kernel-meta cases, so also switch the simulation to `apt-get -s dist-upgrade` for symmetry. Otherwise the count shown in the UI is "upgrade count" but the button performs "dist-upgrade".
3. Pacman path: `pacman -Syu` already does the equivalent of dist-upgrade; no change needed.
4. Doc: note the change in `docs/spec/HOST-MONITORING.md` (the OS Updates section).

**Spot test after fix:**
1. On a Debian/Ubuntu host with a kernel-meta update pending (`linux-generic` → new ABI), click Check — count should include the kept-back packages.
2. Click Upgrade — the kernel meta-package and its new kernel package should both install.
3. After upgrade, Check again — list should be empty (or only contain genuinely-blocked items like phased updates).

**Why deferred:** Behavior change with safety implications (dist-upgrade can remove packages). Wants explicit decision before flipping the default — possibly a setting or a confirmation in the UI ("show what will be removed"). Discovered while fixing concurrency/caching, scope-separated.

---

### Backup directory layout: VMs at top level, containers under `containers/` subdir — should be symmetric

**Found:** 2026-05-03.

**Current state:**
- VM backups land at `<destinationPath>/<vmName>/<timestamp>/` (top-level under the backup root)
- Container backups land at `<destinationPath>/containers/<name>/<timestamp>/` (under a `containers/` subdir)

This made sense when only VMs had backups (single bucket, no namespacing needed). After container backups landed (`cdc5234`, v1.2.0), the asymmetry remains. A backup destination directory mixes `<vmName>/` and `containers/` at the same level, which is confusing — and it precludes ever using `vms/` as a VM name.

**Fix sketch:**
1. Move VMs under their own subdir: `<destinationPath>/vms/<vmName>/<timestamp>/`. Mirror what containers already do.
2. `vmManagerBackup.js`: `createBackup`, `listBackups`, `restoreBackup`, `deleteBackup` all need updated paths. Search for `join(destinationPath, vmName, ...)`.
3. **One-time corrective sweep on existing installs.** Per CLAUDE.md feature-building rules, this is a structural change, not a bug-state repair — so we either:
   - Accept the asymmetry permanently and only enforce `vms/` for *new* backups (loses the symmetry benefit, leaves old backups discoverable via fallback path);
   - Decide this is bug-state repair (the asymmetry was a structural mistake) and write a one-time mover script that walks the destination root, identifies VM backup dirs (those with `domain.xml` at the right depth), and `mv` them into a new `vms/` subdir;
   - Document the new layout and require users to manually move existing backups (clunky; users might miss it).

   Real call needed at design time. Lean toward bug-state-repair sweep — it's simple, idempotent, and the alternative is permanent ugliness in the API/spec.

4. Doc updates: `docs/spec/BACKUPS.md`, API spec for the routes, CHANGELOG.

**Spot test after fix:**
1. Fresh backup destination → take a VM backup → it lands under `<dest>/vms/<name>/<ts>/`.
2. Existing destination with old-style VM backups → after upgrade, they appear under `<dest>/vms/`. Listing/restoring works.
3. Container backup still works under `<dest>/containers/...`.

**Why deferred:** Asymmetry is ugly but not actively broken. Touches a persistence boundary that needs careful design (existing-data handling) — not a "do it in 30 min" change.
