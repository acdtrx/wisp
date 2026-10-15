# Fix Plan 3 — Robustness and correctness (remaining Mediums)

**Audit:** [`AUDIT.md`](AUDIT.md). **Created:** 2026-10-16. Conventions: see
[`PLAN-1-SECURITY.md`](PLAN-1-SECURITY.md) § Shared conventions.

---

## R1 — Frontend crash and stale state

**Findings:** F1, F2 (+ logs sibling, ImageLibrary unconfirmed), F3. **Decision needed: yes (F1 boundary).**

**Fix:**
- F1: `statsStore` ignores frames with `error` (keep last good stats), matching the other topic
  stores. **Ask:** also add one top-level React error boundary? Recommended — it's the only
  thing that turns any future render throw into a recoverable state instead of a white page —
  but it is a new pattern, so the user decides.
- F2: after each await in `selectVM`/`refreshSelectedVM`/`selectContainer`/`refetchRuns`, drop
  the result if the selected name changed (per-select sequence number). Confirm ImageLibrary
  ordering and apply the same guard if real.
- F3: backend returns 422 `INVALID_PASSWORD` for a wrong current password (401 stays "no
  session"); frontend shows the inline error.

**Acceptance:** harness: push a `{error}` stats frame → page stays, last stats shown; throttle
network, switch VM A→B quickly → B's page shows B; wrong current password → inline error,
session kept, other tabs unaffected.
**Verify:** darwin dev stack + harness (memory: fetch-based SSE can be canned).
**Docs:** `ERROR-HANDLING.md` (stats error frames), `AUTH.md` (422 for wrong current password), `UI.md` if boundary added.

---

## R2 — Request-lifecycle leaks

**Findings:** A4, C12. **Decision needed:** no.

**Fix:** in every SSE/WS handler listed in A4, register teardown before the first `await`, or
check `request.raw.destroyed` / `socket.readyState` after it and tear down immediately. One
helper if the pattern repeats (CODING-RULES §2: by purpose). `execCommandInContainer`: SIGKILL
the exec process on timeout before `deleteProcess`, destroy FIFO streams, clear the timer.

**Acceptance:** loop 200× open-and-abort `/api/events` during initial gather → listener counts
and interval count return to baseline (expose via a debug log or heap check); closing the
container console during exec setup leaves no `sh` in the container; a hung reload exec is
killed at 15 s.
**Verify:** darwin for `/api/events`; Linux for consoles/exec.

---

## R3 — Progress event volume and job retention

**Findings:** V11, V15. **Decision needed:** no.

**Fix:** emit progress only when integer percent changes (as `copyAndConvert` does); job store
keeps only the latest progress event (plus non-progress steps) for replay; expiry measured
from completion, per-job (or a sweep that reschedules while jobs remain).

**Acceptance:** 10 GB backup emits ≤ ~101 progress events; reconnecting tab replays a short
history; a 2 h job remains fetchable for the full TTL after completion.
**Verify:** darwin for jobStore unit behavior via a small script; Linux for a real backup.

---

## R4 — OS update helper

**Findings:** P3, P2, P4. **Decision needed: yes (P4).**

**Fix:**
- P3: `wisp-os-update` exports `DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a` and passes
  `-o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold`; Node side spawns with
  `stdio: ['ignore', …]`.
- P2: `containerd.sh` picks `linux/debian` vs `linux/ubuntu` from `ID`/`ID_LIKE`, uses
  `UBUNTU_CODENAME` when set; removes the list file if `apt-get update` fails.
- P4 **(ask):** (a) `checkupdates` from `pacman-contrib` — new system package + new exec
  (allowlist change); (b) sync into a scratch copy via `pacman -Sy --dbpath <tmp>` — no new
  tool, **recommended**; (c) drop Arch support for update checks.

**Acceptance:** upgrade with a locally-modified conffile completes non-interactively keeping the
local file; Debian 12 container/VM run of `containerd.sh` succeeds; Arch check leaves
`/var/lib/pacman/sync` mtime unchanged.
**Verify:** Linux server (Ubuntu) for P3; a Debian VM for P2; Arch only if available — otherwise
state unverified. **Docs:** `DEPLOYMENT.md:321`, `HOST-MONITORING.md` / `SETTINGS.md` as applicable.

---

## R5 — Container lifecycle semantics

**Findings:** C2, C4. **Decision needed: yes (C2).**

**C2 (ask):** (a) implement an exit reconciler on `/tasks/exit` that applies
`always`/`on-failure`/`unless-stopped` with exponential backoff — real feature, clear use case
(Caddy crash takes every proxied service down); (b) remove `restartPolicy` from UI, MCP and
spec, backlog it with trigger "a container crash went unnoticed". Per "features earn their
place": the field is already promised in the UI/MCP, so (a) is fixing a broken promise rather
than adding a speculative feature — **recommended (a)**.

**C4:** move digest-file refresh and `notifyContainerConfigWrite('*')` into
`checkAllImagesForUpdates`, so REST, hourly and MCP callers behave the same.

**Acceptance:** (a) `kill -9` the Caddy task → restarted within backoff; user Stop → stays
stopped; MCP `check_image_updates` after a new tag → lists it and the UI badge appears without
another event.
**Verify:** Linux server. **Docs:** `CONTAINERS.md` (:89, :412), `MCP.md`.

---

## Phase 3 exit

All bundles merged; darwin and Linux results recorded.

---

## Added during implementation

**R6 — Container exec FIFO I/O off the libuv threadpool** (found by the R2 implementer). `fs.ReadStream`
on a FIFO blocks a pool thread for as long as the FIFO is idle: each open container console pinned
one of the 4 default threads, so 4 idle consoles stalled every fs/dns/crypto/zlib call and blocked
process exit; the interactive failed-Start path leaked blocked opens. Fix: non-blocking opens
wrapped in `net.Socket` (epoll), opened before `Tasks.Start` (decision recorded in CONTAINERS.md).
Linux (tini) harness: EOF delivered on writer close (macOS kqueue does not — darwin couldn't prove
it); io round-trip + `exit` EOF, execCommand `exitCode 3` in ~76 ms, 10 idle consoles with
`readFile` in 0 ms, failed-start ×3 leaves nothing, timeout kill path intact, close-mid cleans up.
