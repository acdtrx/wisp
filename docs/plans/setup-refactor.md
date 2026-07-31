# Setup / Install / Update — Strategy Refactor

## Why this exists

While fixing the wisp-bridge / netplan stub IP bug (May 2026), it became clear that Wisp has **two parallel deployment paths** that don't share a single source of truth, and the split causes correctness bugs:

- **`push.sh` → `install.sh` → `setup-server.sh --skip-bridge`** — runs the full server-setup chain on every push. Used in the dev workflow.
- **`wisp-updater` (self-update from GitHub release)** — runs only `install-helpers.sh` + re-templates `wisp.service`. Deliberately conservative.

Anything we add to `setup-server.sh` is auto-picked-up by push.sh installs but **not** by self-updates. Existing self-updated installs drift from the intended setup state.

This doc captures the bigger refactor — not for execution now, but to remember the ideas and the issues we surfaced.

## Symptoms / forces driving this

1. **Self-updated installs miss new setup logic.** Whenever we add a new privileged helper, a new netplan rule, a new udev rule, a new sysctl tweak, etc., it ships in `setup-server.sh` but doesn't reach existing installs. Today this is hand-waved with "users can re-run install.sh" — but they don't, and self-update is supposed to be a first-class deployment path (per `CLAUDE.md`).
2. **Persisted state can drift from spec.** The wisp-bridge stub-IP bug (May 2026) is one example: `bridge.sh` wrote a netplan YAML missing the stub IP; `wisp-bridge` later did `netplan apply` and wiped the runtime-only address. We fixed it with a targeted `bridge-config.sh` patch script (Phase 1, see below) — but this is a class of bug, not a one-off.
3. **`setup-server.sh` is one big script with mixed concerns.** Some steps are fast and idempotent (dirs, install-helpers, container-dns, rapl). Some are slow (`packages.sh` does `apt update`). Some are disruptive if re-run while wisp/containerd are alive (`containerd.sh` may bounce containerd, killing all running containers).
4. **`bridge.sh` is structurally not idempotent.** Early-exits when `br0` exists, so it can't regenerate the YAML to fix drift. Phase 1 worked around this by extracting YAML rendering into `bridge-config.sh`. Other setup scripts may have the same structural issue and need similar splits.
5. **`run_step` swallows failures.** `setup-server.sh` wraps each step so a failure doesn't abort the whole run — good for first install, bad for updates where silent partial-success could leave the system in a broken state. The `FAILED_STEPS` list is reported to stdout but not propagated as a non-zero exit.
6. **No clear "update-safe" classification.** Each setup script either is or isn't safe to re-run during a live update (wisp stopped, containerd may be running). Today this is implicit; nothing enforces it.

## What we tried first (Phase 1, May 2026) — and rolled back

Initial attempt: declare `169.254.53.53/32` in `/etc/netplan/90-wisp-bridge.yaml` under `bridges.br0.addresses` alongside `dhcp4: true`, and patch existing installs' YAML via a new `bridge-config.sh` + Python YAML script called from both `setup-server.sh` and `wisp-updater`.

**Why we rolled it back:** on Ubuntu (systemd-networkd as the netplan backend), declaring a static `addresses:` array alongside `dhcp4: true` on a **bridge** put networkd into a `routable (configuring)` reconcile loop. Symptoms on the test box (tini):
- `ip monitor address` showed the DHCP-acquired LAN address being deleted and re-added in a tight loop (10k+ events/min).
- avahi-daemon couldn't keep up — joining/leaving multicast groups continuously, eventually publishing only `127.0.0.1` for `tini.local`.
- The Wisp UI was unreachable via `tini.local`. Host networking itself stayed up (SSH worked) but mDNS-dependent flows broke.

Removing the `addresses:` block and re-running `netplan apply` returned networkd to `routable (configured)` immediately and avahi recovered.

**The actual fix shipped:** `wisp-bridge`'s `apply_netplan()` re-asserts `169.254.53.53/32` on br0 after every `netplan apply` (idempotent — no-op when the IP is already there). The stub IP remains runtime-only, asserted at three points:
- `container-dns.sh` at install time
- `wisp.service` `ExecStartPre=+` at every service start
- `wisp-bridge`'s `apply_netplan()` after every managed VLAN bridge create/delete

This is what works on the user's other (pre-refactor) servers and matches the existing system design. The "declarative netplan" idea was structurally appealing but didn't survive contact with networkd's bridge-with-DHCP behavior.

### Lesson recorded (not for re-litigation)

When tempted to make the stub IP netplan-declared in the future:
1. Test the dual `dhcp4 + addresses` config end-to-end on Ubuntu's networkd, not just netplan parsing.
2. Watch `networkctl status br0` — `routable (configured)` settled vs `routable (configuring)` looping is the signal.
3. The trigger is bridge-specific. Same YAML on a non-bridge ethernet may behave differently.

### Resolved 2026-07-31 — the networkd drop-in shipped

The escape hatch this section left open ("a separate dropin using `Address=` directly in a per-bridge networkd `.network` snippet, bypassing netplan's bridge handler") is what runtime assertion ultimately needed, because the three assertion points had a hole: **none of them covers a `systemd-networkd` restart while wisp is already running.** Ubuntu's `apt-daily-upgrade.timer` restarts networkd often enough to hit this every few days. When it does, networkd re-applies `10-netplan-br0.network` to the existing bridge and flushes the foreign `169.254.53.53/32`; wisp's forwarder socket stays bound to the vanished address and silently black-holes *all* container DNS until the process restarts. Diagnosed from a 10-hour outage that surfaced only as Caddy 502s.

`container-dns.sh` now writes `/etc/systemd/network/<br0-unit>.d/wisp-mdns-stub.conf`, resolving `<br0-unit>` from `networkctl status br0` so one code path covers netplan-rendered and `bridge.sh`-written units alike. `wisp-updater` gained a `container-dns` step so self-updated installs pick it up — exactly the class of drift item #1 of this document warns about.

The Phase 1 workaround above (`wisp-bridge`'s `apply_netplan()` re-assert) was **removed**, not kept alongside: networkd re-applies the drop-in when netplan re-renders the bridge, so the re-assert became dead code. Safe to drop because the updater installs the new `wisp-bridge` and writes the drop-in before starting the service, and a `container-dns` failure rolls the whole update back to the previous install — which still carries the old re-assert. Residual gap: netplan rendering to NetworkManager gets neither mechanism (no networkd-managed br0 → no drop-in), a config Wisp does not target.

Verified on the production host: `networkctl status br0` settles at `routable (configured)` with no address flapping, and the address survives both `networkctl reconfigure br0` and `systemctl restart systemd-networkd` — the reproducer that reliably destroyed it beforehand.

Phase 1 explicitly did NOT solve the broader update strategy. The runtime-assertion fix doesn't need a `wisp-updater` hook because it lives entirely in `wisp-bridge` (which is re-installed on every update by `install-helpers.sh`, already in `wisp-updater`).

## Step 1 landed 2026-07-31 — `common-steps.sh`

Symptom #1 ("self-updated installs miss new setup logic") now has a seam. `scripts/linux/setup/common-steps.sh` holds the steps both paths run — `container-dns.sh` then `install-helpers.sh` — and is called by `setup-server.sh` and `wisp-updater` alike. Behaviour is unchanged; the point is that there is now **one list** instead of the updater hand-picking a subset, and that the updater invokes it from the freshly swapped tree, so adding a step there reaches installs and updates simultaneously with no one-release lag.

An audit done while landing this corrected several assumptions in the list below — most steps are far safer to re-run than "unaudited" implied:

| Script | Re-run behaviour | Safe on a live update? |
| --- | --- | --- |
| `groups` `dirs` `libvirt` `cni` `container-dns` `install-helpers` `rapl` | no service restarts, no prompts, idempotent | yes |
| `bridge` | early-exits when a non-virbr bridge exists, before any config write; the `read` calls are `ip route` / nameserver parsing, **not** prompts | yes (still `--skip-bridge` from the updater — an unattended `netplan apply` has no operator to reconnect) |
| `containerd` | `systemctl enable --now` plus `restart` **only** `if $NEEDS_RESTART` (its config actually changed) | yes on routine updates; a release that changes containerd config will bounce running containers |
| `sanity` | `check_fail()` only prints; always exits 0 | yes (but it therefore cannot report failure) |
| `packages` | `apt-get update` + install | **the one real hazard** — takes the dpkg lock, so overlapping `apt-daily-upgrade` fails the step; under strict semantics a transient lock would roll back a good update |

So "wisp-updater just calls `setup-server.sh`" is close to viable. What still blocks it:

1. **`run_step` always returns 0** and `setup-server.sh` exits 0 even with failures, so the updater would lose its rollback trigger entirely. Needs a `--strict` mode used only by the updater, leaving the install path's leniency intact.
2. **`packages.sh` needs to be non-fatal even under strict**, for the dpkg-lock reason above — best-effort by nature, unlike helper installation.
3. `packages.sh` installs most packages while `containerd.sh` installs containerd itself — the same accretion this document is about. Worth consolidating before, or as part of, the move.

## Ideas for the bigger refactor

Some are mutually exclusive; some compose. Listed without committing to any.

### Option A — `setup-server.sh --update-mode`

Add a flag that runs only the cheap, idempotent, update-safe subset:
- skip `packages.sh` (slow apt operations, rarely changes anything between releases)
- skip `containerd.sh` (if it bounces containerd; needs audit)
- skip `bridge.sh` first-install path; run `bridge-config.sh` instead
- run everything else (dirs, container-dns, cni, install-helpers, rapl, sanity)

`wisp-updater` calls `setup-server.sh --update-mode` instead of just `install-helpers.sh`. Future additions to `setup-server.sh` are automatically picked up provided the new step is update-safe.

**Pros:** single source of truth; small change; backwards-compatible with `push.sh`.
**Cons:** the "is this step update-safe?" classification is implicit (per-script knowledge); easy to break by adding a non-safe step without realizing.

### Option B — Split setup into per-step scripts with explicit metadata

Each script in `scripts/linux/setup/` declares (via header comment, separate manifest, or filename convention) whether it's:
- `install-only` (runs once, e.g. groups.sh — adding the user to libvirt group only matters at install)
- `update-safe` (idempotent, fast, doesn't bounce running services)
- `disruptive` (may bounce services; only run on first install or when explicitly requested)

`setup-server.sh` reads the metadata and runs accordingly. `--update-mode` runs only `update-safe`.

**Pros:** explicit classification; easier to reason about; future steps default to a known category.
**Cons:** more infrastructure than current ad-hoc; new convention to maintain.

### Option C — Refactor each script for re-runnability

Like the `bridge.sh` → `bridge.sh + bridge-config.sh` split we did in Phase 1, but applied broadly:
- `containerd.sh` → split "install containerd" from "ensure containerd config drop-in is current". The latter is update-safe and doesn't bounce containerd.
- `libvirt.sh` → similar split.
- etc.

Then `setup-server.sh --update-mode` calls only the `*-config.sh` family.

**Pros:** clearest separation of concerns; matches what we already did for bridge; each script has a single responsibility.
**Cons:** lots of mechanical work to refactor every setup script; many of them may not need a config-update mode at all.

### Option D — Drop `setup-server.sh` from the update path, formalize a new "update hooks" directory

`scripts/linux/update-hooks/` — every file here is run by `wisp-updater` in lexical order. Each is a small, focused, update-safe script. Adding new update logic = drop a new file in this directory. `setup-server.sh` for first install only.

**Pros:** very clear what runs on update vs first install; no shared script with mixed concerns.
**Cons:** duplication risk (update-hook may need to do similar work to a setup-server step).

### Option E — Make `setup-server.sh` itself fully update-safe

Audit every step. Make every one fast + idempotent + non-disruptive. `packages.sh` becomes a no-op when all packages are present. `containerd.sh` doesn't bounce containerd if its config is unchanged. Etc. Then `wisp-updater` just calls `setup-server.sh` directly, no flag.

**Pros:** simplest end-state — one script, runs on install and update.
**Cons:** by far the most upfront work; some steps may genuinely be hard to make non-disruptive (e.g. `bridge.sh`'s `netplan apply` at first install always disrupts the network briefly).

## Concrete things to audit when this gets prioritized

These are work items, not decisions. Each surfaces a fact we'll need before designing the refactor.

- **`containerd.sh`** — does re-running it bounce `containerd`? If yes, what's the minimum needed to update containerd's config without bouncing it? (drop-in reload? `systemctl reload`?)
- **`libvirt.sh`** — same audit. Does re-running disrupt running VMs?
- **`packages.sh`** — measure end-to-end time on a typical apt cache. If it's <5s, including it in update path is fine. If 30s+, exclusion is justified.
- **`run_step` in setup-server.sh** — should `FAILED_STEPS` propagate to a non-zero exit? Affects how `wisp-updater` reports update success.
- **`install-helpers.sh`** — already in `wisp-updater`. Is the duplication (it's also in `setup-server.sh`) intentional, or do we drop it from one?
- **First-time install vs update interactivity** — `install.sh` has interactive prompts (password, bridge). `setup-server.sh --skip-bridge` is non-interactive. The boundary between interactive and non-interactive is currently in `install.sh`, not `setup-server.sh`. Keep it that way.

## Out of scope (this doc)

- Refactoring `wispctl.sh` (separate concern — user-facing CLI).
- Changing the GitHub Releases tarball shape (separate concern — `package.sh` / `release.sh`).
- Migrating away from the bash setup-script style entirely (e.g. to Ansible). Not necessary for Wisp's scale.
- Anything related to the modules-boundaries refactor (different campaign — see `docs/plans/modules-boundaries.md`).

## Decision when to start

Two reasonable triggers:

1. **A second drift bug ships.** Phase 1 fixed one; if/when another similar issue surfaces, it's the signal that the structural fix matters.
2. **A new setup-server.sh addition we'd want auto-applied to existing installs.** E.g. a new udev rule, a new privileged helper that requires a sysctl tweak, etc. The next "I added X to setup but old installs don't have X" pain point.

Until one of those, Phase 1's `bridge-config.sh` hook is sufficient.

## Decisions log

(empty)
