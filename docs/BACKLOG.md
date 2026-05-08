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
