# Known defects

Phase 2 of `docs/reviews/2026-11-17/IMPLEMENTATION.md`. Findings P-5, R-7, C-2, D-8, and
the suspected V-4, V-6, V-10, D-4 and R-10, of that folder's `AUDIT.md`; plus the backlog
entries named below. P-1 (fresh install) and P-3 (upgrades that skip migrations) moved to
phase 7 on 2026-11-18: their fixes are designs, not patches.

## What it is for

The audit met a handful of defects while looking for something else. They are stability
problems today, each is small, and none needs the larger reworks of the later phases.
This feature fixes the confirmed ones, and settles the suspected ones by reproducing each
on the test host: confirmed or dismissed, with what was observed.

## What it changes in the docs

- `specs/ERROR-HANDLING.md`, `specs/API-CONTAINERS.md` and `specs/API-BACKUPS.md`: the
  503 `NO_CONTAINERD` a create, rename or restore answers when containerd cannot be
  reached.
- `specs/noVNC.md`: the pinned version and where it is named, in a line.
- `BACKLOG.md`: the entries named under each milestone are removed.
- `docs/reviews/2026-11-17/IMPLEMENTATION.md`: milestone 4's outcome for each suspected
  finding, at the phase that owns it.

## Constraints

- A defect whose clean fix is a later phase's design is confirmed here and left whole to
  that phase: nothing is patched halfway (the plan's ground rule 1).
- No fix adds a second way of doing something.
- On the test host: throwaway workloads only, removed afterwards; its containerd, its
  system bus and its existing workloads are never stopped or restarted. What needs a
  host that can be broken (a dropped bus, a dead share, the installer) runs in a
  throwaway VM.

## Milestones

### 1. Failures the UI drops

- The image-update check shows in the job tray after a page reload (R-7).
- A failed "Eject" in an app's config shows its error (D-8).
- A failed host shutdown or restart, and a failed SMB mount toggle, show their error.
- An empty or relative path typed into the App Config form, and an empty one in Host
  Backup, reaches the backend, and its refusal is shown. (A relative path in Host Backup
  already does.)

Backlog: "Host power and the SMB mount toggle swallow errors", "Settings forms drop bad
paths on the client".

Acceptance:

- With an image-update check running, a reload shows it in the tray until it ends.
- Each of the four failures, forced (a backend answer of 500 or 422), shows its message
  on screen and leaves the control usable.
- `npm run check` and the frontend build pass.

### 2. Containers when containerd is away

- Create, restore as new and rename answer an error when containerd cannot be reached,
  and no longer treat the name as free (C-2).
- A local image is not pulled again because containerd could not be asked.
- A failed task delete during cleanup is reported with the start's error, not dropped.

Backlog: "Container task-delete errors are swallowed".

Acceptance, with a backend that points at a containerd socket nobody answers on:

- Create, restore as new and rename each answer the documented error, and write nothing
  to disk.
- With containerd reachable, create, restore as new and rename work as before, and a
  name in use still answers `CONTAINER_EXISTS`.

### 3. noVNC and the SMB connection test

- noVNC is fetched at a pinned release, v1.7.0, by one script that every build uses:
  hosts, CI and the dev machine. The version is named in that one place (P-5).
- A failed SMB connection test leaves no `smb-check-*` directory.

Backlog: "A failed SMB connection test leaves its `/mnt/wisp/smb-check-*` directory" and
"A failed SMB check leaves its mount point" (one defect, entered twice).

Acceptance:

- A build on a tree that holds an older noVNC copy fetches the pinned one; a second
  build fetches nothing. On the test host, a VM console opens and takes keyboard input
  with the pinned version.
- A failed SMB test (bad password, unreachable host) leaves `/mnt/wisp/` as it was.

### 4. The suspected five

Each is reproduced on the test host or in the throwaway VM. Confirmed and small: fixed
here. Confirmed and part of a later phase's rework: left to that phase, with what was
observed. Not reproduced: dismissed, with what was tried.

- V-4: a VM created as `uefi-secure` reads back as such; a firmware change keeps or
  cleans its `VARS.fd`.
- V-6: with an SMB share whose server has gone, mounted by Wisp (soft) and by hand
  (hard), the backend still answers.
- V-10: after the system bus restarts, `.local` names are published again without a
  backend restart.
- D-4: a VM and a container with the same name; a backup of one does not mark the other
  busy.
- R-10: a container mount whose name contains `%` can be listed, edited and removed.

Acceptance:

- For each of the five: the steps run, what was seen, and the outcome (fixed, left to
  phase N, dismissed), written into `IMPLEMENTATION.md`.
- For each one fixed here, its line above is observed to hold.

## Not in this feature

- The fresh install and the migrations (phase 7), the job `subject` field (phase 3), the
  per-VM define lock, the firmware rework and the `host` catch sweep (phase 5).
- Any other backlog entry.
