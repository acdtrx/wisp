# UI: the container page

What a container's page shows and how each thing on it is changed. The shell, the
sidebar and the shared components are in [UI.md](UI.md); the three shapes (view, edit,
act) are in `FRONTEND-RULES.md`, Data. Settled 2026-11-21.

Built by `features/workload-pages.md`. Until its milestone lands, the page is as
[UI.md](UI.md) describes it; that text is removed when this page is built.

## The page

- **Header**: the container's icon and name, its state, and the tabs Overview, Logs and
  Console. Actions, as icons: Start when it is stopped; Stop and Restart when it runs. A
  "More" menu holds Kill, Rename, Change icon, Back up now, Delete, and for an app
  container Eject. "Restart to apply" shows while a saved change waits for the next
  start.
- **Figures**, in a row under the header while the container runs: address, local name,
  uptime, CPU, memory, as the stats stream carries them. Each sits in a cell of fixed
  width. Stopped, the row says so.
- **Groups**, in the order below. Each is a card: a title, its values as text, and its
  actions as icons.
- A container that is gone shows the gone page ([UI.md](UI.md), View Switching).

## The lock

Rename and the Network group's Edit are disabled unless the container is stopped, with a
small lock by the group's title; the disabled action says "stop the container first".
Everything else can be changed while it runs.

## Groups

| Group | Shows | Changed by | Request |
|---|---|---|---|
| **The app's own** (an app container) | See below | The app's rows and forms | `PATCH /api/containers/:name` `{ appConfig }`, the whole config |
| **Image** | The image; "Update available" when a newer one was pulled | Edit: the image. An update is applied by Restart | `PATCH` `{ image }` |
| **Environment** (not an app container) | Each variable; a secret shows as "Secret" | Add, Edit, Remove | `PATCH` `{ envPatch }` |
| **Storage** | Each mount: its path, kind and size | Add a folder, a file or a memory folder; Edit; Remove; open a file's content; upload | The mount routes ([API-CONTAINERS.md](API-CONTAINERS.md)) |
| **Network** | A switch: announce as `<name>.local`. Bridge, MAC, and the services it announces | The switch, at once. Edit *(needs stopped)*: bridge, MAC. A service: Add, Edit, Remove, while the local name is on | `PATCH` `{ localDns }`; `PATCH` `{ network }`; the service routes |
| **Limits and restarts** | CPU limit, memory limit, what happens when it stops | Edit | `PATCH` `{ cpuLimit, memoryLimitMiB, restartPolicy }` |
| **Start-up and backups** | The last backup | Two switches: start with the host; include in the nightly backup. Back up now | `PATCH` `{ autostart }`, `{ autoBackup }`; the backup route |
| **Advanced** | Command, whether it runs as root, shared devices | Edit | `PATCH` `{ command, runAsRoot, devices }` |

- **Rename** *(needs stopped)* asks for the new name in a small dialog and sends `PATCH`
  `{ name }`; the page then moves to the new name.
- A secret variable or file is write-only: its form starts empty and keeps the stored
  value unless one is typed.

## App containers

An app's own group comes first. It is built from the same pieces: values as text, a list
with a form per row, switches that act at once. A row saved or removed sends the whole
app config with that row changed.

| App | Lists | Groups with Edit | Switches |
|---|---|---|---|
| Caddy | Sites | Domain and certificates | — |
| Zot | Users | Address; Sign-in (SSO) | — |
| Jellyfin | Libraries | Published address | Use the GPU |
| Tiny Samba | Shares; Users | Server | — |

- Removing a Samba share whose data would be deleted asks first, naming what goes.
- A password or token field in a form is empty and keeps the stored one unless typed.

## States

- A group whose data is loading shows a skeleton; one whose read failed shows the error
  with Retry ([UI.md](UI.md)).
- An empty list says so in a line ("No variables.").
- A form's Save is busy until the server answers; a failure shows in the form, which
  stays open. An action's failure shows in the page's error display.
- While a job runs on the container (a backup, a start), what the server would refuse is
  disabled and says which job.

## New container

One form, its own page: the name, and either an image or one of the apps (which fills in
its image). Create leaves the container stopped, so it can be set up before its first
start, and opens its page if the user is still on the form.

## Phones

The same groups in one column. The figures are centred, in two rows. A form opens as a
sheet from the bottom. Every action stays visible: none hides behind a hover.
