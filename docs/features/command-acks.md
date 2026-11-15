# Command acks

**For:** making every state-changing REST command answer with an ack and every client take
the new state from the stream, as ARCHITECTURE § Transport says (settled 2026-11-15). Today
short commands answer with their result, the screen that sent them GETs straight after,
and many changes reach no stream, so a second tab never sees them. Closes the backlog
entry "Short commands answer with their result".

**Specs and docs changed:** `specs/API.md`: Command responses and the `changes` topic
(written with this feature), and each route's success response as its milestone lands;
`specs/MCP.md`: tools are exempt (written); `specs/SETTINGS.md` where it describes a
response; `ARCHITECTURE.md` § Transport: the `changes` topic, in milestone 1.

**Settled with the feature (2026-11-15):**
- One `changes` topic of references; full lists stay on the topics they have.
- The module that saved a change publishes it, never the route. The managers stay strict
  (CODING-RULES §7): each exposes its own subscribe surface, as for its network events.
- A screen drops its follow-up GET after a command: the `changes` frame (or its topic)
  drives the refresh, in the tab that sent the command as in every other.
- `requiresRestart` leaves the responses: the record's `pendingRestart` carries it.

**Out of scope (backlog):** merging the job progress streams; `GET
/api/host/updates/packages?refresh=1` starting a job; MCP's `get_job` reading one job
store; errors swallowed by host power and the SMB mount toggle.

**Every milestone's acceptance includes:**
- The milestone's routes answer per API.md, Command responses: checked with `curl -i`
  against the dev backend (or the Linux server for manager paths, CODING-RULES §14).
- **Two-tab check:** each command run in tab A shows in tab B with no reload and no
  user action.
- An error that keeps a command from starting still shows where it did before (inline,
  in the modal, the alert dialog).
- The frontend build, `npm run check-imports` and `npm run check-fences` pass.

## Milestone 1 — the `changes` topic, with settings

The topic in `/api/events` (connect snapshot `{ kind: "all" }`), its client side (a
subscription a view uses to GET what it shows), and settings end to end: `PATCH
/api/settings` and `PATCH /api/settings/oidc` answer 204, the settings module publishes
`{ kind: "settings" }`, and every settings screen (App Config, Host backup, the backup
scheduler, single sign-on, the Wisp update channel) reads the settings store.

- **Acceptance:**
  - Changing the server name, the backup path, the backup schedule, the update channel
    and the OIDC settings in tab A shows in tab B.
  - Restarting the dev backend with tab B open: once the stream reconnects, tab B shows
    a settings value changed by hand in `wisp-config.json` while it was down.

## Milestone 2 — sections and the home page

The five section routes and the nine home-page routes: 204, or `201 { id }` for a new
section, group or manual tile. The stores take their state only from the `sections` and
`home` topics. Create-and-assign (sidebar and section picker), new group with rename,
and the tile group picker work from the returned id.

- **Acceptance:**
  - Create, rename, reorder, delete and assign sections, and create a section from the
    picker with a workload assigned to it at once; the same for home-page groups, tile
    assignment, tile overrides and manual tiles: each shows in tab B.
  - A newly created section or group opens in rename mode in tab A, as today.

## Milestone 3 — VMs and cloud-init

`PATCH /api/vms/:name`, the disk, CD-ROM and USB routes, stop / reboot / suspend /
resume, and the cloud-init PUT and DELETE answer 204; the VM job routes answer 202.
vmManager publishes a change for every saved VM change, hot-plug on a running VM
included; the cloud-init glue publishes its own. The VM detail view GETs on `{ kind:
"vm", id }`.

- **Acceptance (on the Linux server):**
  - Each of: a general edit, a rename, a NIC edit, a disk create, attach, resize, bus
    change and detach, an ISO attach and eject on a running and on a stopped VM, a USB
    attach and detach on a running VM, a cloud-init save and removal: shows in tab B's
    open VM detail.
  - A rename in tab A moves tab B's open view to the new name.

## Milestone 4 — containers

`PATCH /api/containers/:name` (rename and app config included), kill, the mount and
service routes, mount file content, init and the file upload answer 204;
`POST /api/containers` and the job routes answer 202. containerManager publishes a
change for every saved container change. The detail view GETs on `{ kind: "container",
id }`; rename is followed from the request, the restart badge from `pendingRestart`.

- **Acceptance (on the Linux server):**
  - Each of: a general edit, a rename, an env and a network edit, an app config save,
    a device change, a mount add, edit and delete, a file upload, a file content edit, a
    mount init, a service add, edit and delete: shows in tab B's open container detail.
  - An edit that needs a restart shows the restart badge in both tabs.

## Milestone 5 — host, library, images, tokens, updates

Host mounts (`201 { id }` on create, 204 on edit and mount), network bridges, the
library (upload, rename and delete answer 204, a download's completion publishes too),
image delete, token revoke, and `POST /api/updates/check` (204, the status on `{ kind:
"wisp-update" }`) answer per Command responses; every remaining job route answers 202.

- **Acceptance (mounts and bridges on the Linux server):**
  - Each of: a host mount add, edit, mount, unmount and delete; a bridge create and
    delete; a library upload, rename, delete and finished download; an image delete; a
    token revoke; an update check: shows in tab B.
  - A new API token still shows its secret once in tab A, and appears in tab B's token
    list without it.
  - `npm run route-access` and a scan of `backend/src/routes/` find no state-changing
    route outside the exceptions in API.md that answers with a body other than the acks.
