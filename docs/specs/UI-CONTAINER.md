# UI: the container page

What a container's page shows and how each thing on it is changed. The shell, the
sidebar and the shared components are in [UI.md](UI.md); the three shapes (view, edit,
act) are in `FRONTEND-RULES.md`, Data. Settled 2026-11-21.

## The page

- **Header**: the container's icon and name, its state, and the tabs Overview, Logs and
  Console. Actions, as icons: Start when it is stopped; Stop and Restart when it runs. A
  "More" menu holds Kill, Rename, Change icon, Back up now, Delete, and for an app
  container Eject. "Restart to apply" shows while a saved change waits for the next
  start. While the restart policy has a restart scheduled, the header says when and
  its Stop cancels it.
- **Figures**, in one row under the header while the container runs (settled
  2026-11-23), as the stats stream carries them. First what does not move, as one line
  without labels: the address, the local name, and "up" with the uptime. Then the live
  figures, each with its label: CPU and memory, a meter beside each, memory's only when
  the container has a limit. The row never wraps, and no label moves when a figure
  changes: when the row is full the local name is cut first, then the address, the
  whole text on hover; the uptime and the live figures are never cut. A value Wisp does
  not have is left out of the line. Stopped or paused, the row says so ("Stopped",
  "Paused").
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
| **Image** | The image; "Update available" when a newer one was pulled | Edit: the image. An update is applied by Restart. On an app container whose image is not its app's own, **Use the app's image** names that image and saves it | `PATCH` `{ image }` |
| **Environment** (not an app container) | Each variable; a secret shows as "Secret" | Add, Edit, Remove | `PATCH` `{ envPatch }` |
| **Storage** (not an app container) | Each mount: its path, kind and size | Add a folder, a file or a memory folder; Edit; Remove; open a file's content; upload. A zip upload is offered only for a folder kept on this host: for one kept on a storage share it is disabled and says so | The mount routes ([API-CONTAINERS.md](API-CONTAINERS.md)) |
| **Network** | A switch: announce as `<name>.local`. Bridge, MAC, and the services it announces | The switch, at once. Edit *(needs stopped)*: bridge, MAC. A service: Add (one of the image's ports not yet announced, or a typed port), Edit, Remove, while the local name is on | `PATCH` `{ localDns }`; `PATCH` `{ network }`; the service routes |
| **Limits and restarts** | CPU limit, memory limit, what happens when it stops | Edit | `PATCH` `{ cpuLimit, memoryLimitMiB, restartPolicy }` |
| **Start-up and backups** | The last backup | Two switches: start with the host; include in the nightly backup. Back up now | `PATCH` `{ autostart }`, `{ autoBackup }`; the backup route |
| **Advanced** | Command, whether it runs as root, shared devices | Edit | `PATCH` `{ command, runAsRoot, devices }` |

- **Rename** *(needs stopped)* asks for the new name in a small dialog and sends `PATCH`
  `{ name }`; the page then moves to the new name.
- A secret variable or file is write-only: its form starts empty and keeps the stored
  value unless one is typed.
- **A secret file mount** (settled 2026-10-16): its content is never shown or fetched,
  and its row says whether a content is set. In place of the file editor the row offers
  Replace secret content (an empty editor whose Save writes the content) with a Clear
  behind a confirm; Upload stays. Unchecking Secret in the mount's form empties the
  stored file, and the form says so.
- **An action that deletes stored data asks first** and names what goes: removing a
  mount whose folder or file lives on this host. A memory folder, or a mount kept on a
  storage share, is removed without asking: its data is not touched.
- **Back up now** opens the backup dialog (destinations, progress), from the group and
  from the More menu.

## App containers

An app's own groups come first: one card per list and one per group with an Edit. They
are built from the same pieces: values as text, a list with a form per row, switches
that act at once. A row saved or removed sends the whole app config with that row
changed. An app container shows neither Environment nor Storage: the app owns both.

| App | Lists | Groups with Edit | Switches |
|---|---|---|---|
| Caddy | Sites | — | — |
| Zot | Users | Address; Sign-in (SSO) | — |
| Jellyfin | Libraries | Published address | Use the GPU (in the Published address card) |
| Tiny Samba | Shares; Users | Server | — |

- Removing a Samba share whose data would be deleted asks first, naming what goes; so
  does saving a share's form when the edit moves it off this host.
- A password or token field in a form is empty and keeps the stored one unless typed.
- Caddy's page has a **Certificate** card with no Edit: the domain
  its sites are under and the date the host's certificate is valid until, with a link to
  Host → App Config, where it is set up. While Wisp holds no certificate the card says
  so, and that the sites are not served until it does. A site's row shows its full
  name, `<subdomain>.<domain>`, once there is a domain.

## Logs

The Logs tab shows one run at a time, following it as lines arrive.

- A **run picker**, newest first: a green dot for the running one, red for a run that
  ended with a non-zero exit, grey for a clean exit. The list of runs is read again when
  the container's state changes.
- A filter input, and icon actions: **Clear** the viewer (in the browser only: it does
  not touch the files), **Mark** (inserts a divider line with an optional label),
  **Download** (the selected run's log file), **Auto-scroll**.
- The requests: the runs list, the logs stream and the run-log download
  ([API-CONTAINERS.md](API-CONTAINERS.md)).

## States

As on every workload page ([UI.md](UI.md#workload-pages)).

## New container

One form, its own page: the name, and either an image or one of the apps (which fills in
its image). The image is typed, or picked with Browse from the image library's OCI
images; a picked image's name is taken as it is listed. Create leaves the container stopped, so it can be set up before its first
start, and opens its page if the user is still on the form.

## Phones

As on every workload page ([UI.md](UI.md#workload-pages)).
