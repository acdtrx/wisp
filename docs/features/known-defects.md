# Known defects

Phase 2 of `docs/reviews/2026-11-17/IMPLEMENTATION.md`. Findings P-1, P-3, P-5, R-7, C-2,
D-8, and the suspected V-4, V-6, V-10, D-4 and R-10, of that folder's `AUDIT.md`; plus
the backlog entries named below.

## What it is for

The audit met a handful of defects while looking for something else. They are stability
problems today, each is small, and none needs the larger reworks of the later phases.
This feature fixes the confirmed ones, and settles the suspected ones by reproducing each
on the test host: confirmed or dismissed, with what was observed.

## What it changes in the docs

- `specs/DEPLOYMENT.md`: what a fresh install does about the bridge and container
  networking, and the manual upgrade paths, which now run the state migrations.
- `specs/ERROR-HANDLING.md` and the container API file: the error a create, rename or
  restore answers when containerd cannot be reached.
- `README.md`, install section, where it describes the same steps.
- `BACKLOG.md`: the entries named under each milestone are removed.
- `docs/reviews/2026-11-17/IMPLEMENTATION.md`: milestone 4's outcome for each suspected
  finding, at the phase that owns it.

## Constraints

- Each fix is the smallest change that removes the defect. No rework of the code around
  it: that belongs to phases 3 to 7.
- No fix adds a second way of doing something the plan is about to unify. Where the
  right fix is the later phase's rework, the defect is confirmed here and left to it.
- On the test host: throwaway workloads only, removed afterwards; its containerd, its
  system bus and its existing workloads are never stopped or restarted. What needs a
  host that can be broken (a dropped bus, a dead share, the installer) runs in a
  throwaway VM.

## Milestones

### 1. Failures the UI drops

- The image-update check shows in the job tray after a page reload (R-7).
- A failed "Eject" in an app's config shows its error (D-8).
- A failed host shutdown or restart, and a failed SMB mount toggle, show their error.
- An empty or relative path typed into the App Config and Host Backup forms reaches the
  backend, and its refusal is shown.

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

### 3. Install and upgrade

- A fresh install on a host with no bridge: with the bridge accepted, it ends with VM
  and container networking working. With the bridge declined, or with no terminal to
  ask on, it ends by saying plainly that networking is not set up and naming the one
  command that finishes it; that command leaves both working (P-1).
- The manual upgrade paths run the state migrations (P-3).
- noVNC is fetched at a pinned version (P-5).
- A failed SMB connection test leaves no `smb-check-*` directory.

Backlog: "A failed SMB connection test leaves its `/mnt/wisp/smb-check-*` directory" and
"A failed SMB check leaves its mount point" (one defect, entered twice).

Acceptance:

- In a throwaway VM with no bridge, each of the three install outcomes above is run and
  observed: a container gets an address on the LAN and a `.local` name, and the VM-side
  bridge is listed for new VMs.
- A manual upgrade over an install with one migration pending applies it, and the ledger
  shows it.
- Two builds a day apart vendor the same noVNC commit, named in one place.
- A failed SMB test (bad password, unreachable host) leaves `/mnt/wisp/` as it was.

### 4. The suspected five

Each is reproduced on the test host or in the throwaway VM. Confirmed and small: fixed
here. Confirmed and part of a later phase's rework: left to that phase, with what was
observed. Not reproduced: dismissed, with what was tried.

- V-4: a VM created as `uefi-secure` reads back as such; a firmware change keeps or
  cleans its `VARS.fd`.
- V-6: with a hard-mounted SMB share whose server has gone, the backend still answers.
- V-10: after the system bus restarts, `.local` names are published again without a
  backend restart.
- D-4: a VM and a container with the same name; a backup of one does not mark the other
  busy.
- R-10: a storage mount whose name contains `%` can be listed, edited and removed.

Acceptance:

- For each of the five: the steps run, what was seen, and the outcome (fixed, left to
  phase N, dismissed), written into `IMPLEMENTATION.md`.
- For each one fixed here, its line above is observed to hold.

## Not in this feature

- The job `subject` field (phase 3), the per-VM define lock, the firmware rework and the
  `host` catch sweep (phase 5), the helper dialects (phase 7).
- Any other backlog entry.
