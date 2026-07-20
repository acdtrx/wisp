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


