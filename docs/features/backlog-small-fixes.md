# Backlog small fixes

**For:** clearing the backlog entries whose fix is clear and needs no design decision
(agreed 2026-11-12). Remove each entry from `docs/BACKLOG.md` in the commit that fixes
it. Where an entry is only partly in scope, keep the rest in the backlog.

If the code shows an item is not as the entry says, or needs a decision after all, send
it back to the design session as its own point with a recommendation, and continue with
the rest.

**Specs changed** (where the item changes a contract; the rest fix code to match a spec
that already says so):
- `specs/AUTH.md` § Login Rate Limiting: a wrong current password on change-password
  counts against the shared per-IP window (#20).
- `specs/UPDATES.md`: `POST /api/updates/install` answers 409 while an install is
  already in flight (#17).
- `specs/CUSTOM-APPS.md` § Mount content routes, `specs/API.md`, `specs/CONTAINERS.md`:
  the add/delete/zip/init/delete-data mount routes on an app-managed mount return
  `APP_CONFIG_ONLY` (#13).
- `specs/API.md`: cloud-init PUT for a missing VM answers 404 (#5); the backup job's
  `done` result has no host path (#25); the allowed `graphicsType` / `videoDriver`
  values (#2).
- `specs/CONFIGURATION.md` or `DEPLOYMENT.md`, whichever owns it: the dev backend binds
  `127.0.0.1` (#21).

## Milestone 1 — VMs

1. **VM mDNS reconciler:** serialize per VM, the same way the container reconciler
   does (entry "VM mDNS reconciler: per-VM operation chain").
2. **Running-VM edits:** graphics, NIC and video-driver changes on a running VM return
   `requiresRestart: true`; unknown `graphicsType` / `videoDriver` → 422. The paused-VM
   ISO part stays in the backlog.
3. **VM rename:** an existing target directory → 409 `VM_DIR_EXISTS`.
4. **Disk-less VM:** the UI can add an `sda` primary disk.
5. **Cloud-init PUT:** a missing VM → 404, and no directory is created.
6. **libvirt at boot:** a failed first connect retries with the existing reconnect
   backoff.
7. **VNC console:** a mid-session drop reconnects with backoff, as `specs/CONSOLE.md` §
   Auto-reconnect already says.
8. **Domain XML parser:** the `serial` array rule applies to char devices only.

- **Acceptance** (on the Linux test host unless noted):
  - Start and stop a VM 10× quickly. `avahi-browse -art` then shows no record for it
    and no duplicate groups.
  - PATCH graphics on a running VM → `requiresRestart: true`.
  - PATCH `graphicsType: "bogus"` → 422.
  - Rename onto a kept directory → 409 `VM_DIR_EXISTS`.
  - In the UI, add `sda` to a VM created without disks, then boot it.
  - PUT cloud-init for `nosuchvm` → 404, and no `vms/nosuchvm/`.
  - Start the backend with libvirt-dbus stopped, then start libvirt-dbus. VMs appear
    without a backend restart.
  - Drop the network under an open VNC console (e.g. kill the proxy socket). It
    reconnects on its own.
  - A domain with a disk `<serial>` parses it as a string.
  - The frontend build passes.

## Milestone 2 — containers

9. **Rename:** CNI DEL runs for the old netns before it is removed.
10. **Unexpected task exit:** the container's SRV/TXT services are deregistered.
11. **Run finalization:** a task that exits on its own finalizes its run (`endedAt`
    set, a last line without a newline kept).
12. **App config restart flag:** a running container is flagged only when the
    normalized mounts/devices differ, and an `APP_RELOAD_FAILED` rollback restores the
    flag as it was before the save.
13. **Mount routes on app containers:** `POST`/`DELETE …/mounts`, `/zip`, `/init` and
    `DELETE …/data` on an app-managed mount → `APP_CONFIG_ONLY`. The devices half of the
    entry stays in the backlog.
14. **Mount edge cases:** `updateContainerMount` returns a boolean `requiresRestart`
    when there is no task; switching a tiny-samba share from Local to a Storage source
    removes `files/share-<name>`.
15. **Small inconsistencies:** mount POST returns a boolean `requiresRestart`; the
    container page reads "Restart required" from the server after a restart done
    elsewhere; deleting a container prunes its `backup-status.json` entry.

- **Acceptance** (Linux test host):
  - Rename a container; the cni-dhcp log shows a release for the old name.
  - `kill -9` a container's task; `avahi-browse` no longer lists its service.
  - Run a container whose command prints a line with no trailing newline and exits.
    `GET /runs` shows it with `endedAt`, and the line appears in its log.
  - Save an unchanged Caddy config on a running container that live-reloads: no
    "Restart required" badge.
  - Each listed mount route on an app container → 422 `APP_CONFIG_ONLY`.
  - Mount POST on a stopped container → `requiresRestart: false`.
  - Switch a tiny-samba share from Local to Storage; `files/share-<name>` is gone.
  - Restart a container from a second tab or the API; the open page drops the badge.
  - Delete a container; its `backup-status.json` entry is gone.
  - The frontend build passes.

## Milestone 3 — platform and API

16. **Removable disks:** `mountedAt` checks every mount entry for the device, not just
    the first.
17. **Self-update:** a second `POST /api/updates/install` while one is in flight → 409.
18. **Library upload:** the name is reserved with an exclusive create, as downloads do.
19. **Frontend stores:** action loading/error state is kept per workload, not one slot
    per store.
20. **Change-password:** a wrong current password feeds `loginRateLimit.js`.
21. **Dev backend:** binds `127.0.0.1`.
22. **Dev backend:** `runtime.env` is loaded before the config is resolved.
23. **Malformed URLs:** answered in the `{ error, detail }` shape.
24. **Live-data SSE:** stops retrying on a 404, as job streams do.
25. **Backup job result:** `done` carries no absolute host path.
26. **Allowed-roots check:** resolves with `realpath`.

- **Acceptance** (darwin dev stack unless noted):
  - A disk mounted by Wisp and also at a second path reads as mounted by Wisp (Linux
    test host).
  - Two concurrent install POSTs → one 202, one 409 (Linux test host, or the dev stub if
    it reaches the guard).
  - Two concurrent same-name uploads → one succeeds, one 409.
  - In the UI, a slow action on VM A leaves VM B's buttons enabled, and an error from A
    is not shown on B (a Vite harness if needed).
  - Six wrong current passwords on change-password → 429.
  - `lsof -iTCP:8080 -sTCP:LISTEN` on the dev backend shows `127.0.0.1`.
  - `WISP_CONFIG_PATH` set only in `runtime.env` is used by the dev backend.
  - `curl '/api/%zz'` → `{ error, detail }`.
  - An SSE stream for a deleted workload stops after its 404.
  - A backup job's `done` event has no path (Linux test host).
  - A symlink in the image library pointing outside it is rejected.
  - The frontend build passes, and `npm run check-imports` passes.
