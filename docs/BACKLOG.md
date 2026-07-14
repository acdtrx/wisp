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

## Improvements

### Scheduled VM backups (deferred by design)

**Found:** 2026-07-14, while shipping the v2.0.0 backup overhaul (per-workload panel, restore-in-place, attempt status).

**Symptom:** The Backup Scheduler covers containers only. VMs are backed up manually; the panel shows them as implicitly `manual` origin.

**Root cause:** Not a bug — a scope decision. VM backups require the VM stopped, so a schedule means planned downtime per run (or a future live-backup design: qcow2 external snapshot + backing-chain copy while running).

**Fix sketch:** Either (a) scheduled stop→backup→start windows per VM with an explicit downtime warning, or (b) live backups via libvirt external snapshots, which removes the stopped-precondition everywhere. The plumbing is ready: VM manifests already record `origin`, retention/pruning and attempt-status recording are shared, and the scheduler would gain a VM pass next to the container pass.

**Why deferred:** Downtime semantics need a real design decision (option a vs b); the 2026-07-14 decision (artifact D7) was to add the manifest field only and defer the scheduler.

### `text-accent` as link/action text is below AA contrast

**Found:** 2026-07-12, during the text-contrast pass that darkened the text and status tokens to WCAG AA.

**Symptom:** Accent-colored text (`text-accent`, ~29 uses as links/inline actions) sits at 3.1:1 on white — readable but below the 4.5:1 AA threshold for small text. White text on accent buttons has the same 3.1:1 ratio.

**Root cause:** `--color-accent: #0fa396` is the brand color; it was deliberately left out of the contrast pass because darkening it to AA lands near the current hover shade (`#0b8578`) and shifts the brand feel everywhere (buttons, focus rings, active states).

**Fix sketch:** Either darken the accent/hover pair together (e.g. accent ≈ `#0b8578`, hover darker still) and accept the brand shift, or introduce a separate `--color-accent-text` token used only where accent appears as small text, keeping buttons on the current accent.

**Why deferred:** Brand-identity call for the user; the readability complaint that drove the pass was about muted labels, which are fixed.

### `DataTable` numeric `minWidthRem` never generates CSS

**Found:** 2026-07-06, during the mobile table polish.

**Symptom:** None visible — tables size by natural content width, which happens to look right.

**Root cause:** `DataTable` builds `min-w-[${n}rem]` at runtime; Tailwind's scanner never sees the literal class, so no CSS is emitted for the numeric path. Only string-literal values passed by callers (e.g. `"sm:min-w-[56rem]"`) work.

**Fix sketch:** Convert the numeric path to an inline `style={{ minWidth: … }}` (or drop the prop where content width suffices). Note this would *introduce* min-widths that never actually applied — check each table for new scrollbars before shipping.

**Why deferred:** Zero user-visible impact today; changing it silently alters accepted layouts.

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

