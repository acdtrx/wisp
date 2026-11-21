# UI: the VM page

What a VM's page shows and how each thing on it is changed. The shell, the sidebar and
the shared components are in [UI.md](UI.md); the three shapes (view, edit, act) are in
`FRONTEND-RULES.md`, Data. Settled 2026-11-21.

Built by `features/workload-pages.md`. Until its milestone lands, the page is as
[UI.md](UI.md) describes it; that text is removed when this page is built.

## The page

- **Header**: the VM's icon and name, its state, and the tabs Overview and Console.
  Actions, as icons: Start when it is stopped; Stop and Restart when it runs. A "More"
  menu holds Pause or Resume, Force stop, Rename, Change icon, Back up now and Delete.
  "Restart to apply" shows while a saved change waits for the next start.
- **Figures**, in a row under the header while the VM runs: address, host name, uptime,
  CPU, disk and network rates, as the stats stream carries them. Each sits in a cell of
  fixed width. Stopped, the row says so.
- **Groups**, in the order below. Each is a card: a title, its values as text, and its
  actions as icons.
- A VM that is gone shows the gone page ([UI.md](UI.md), View Switching).

## The lock

A group marked *needs shut off* has its Edit, Add and Remove disabled unless the VM is
shut off, with a small lock by its title; the disabled action says "stop the VM first".

## Groups

| Group | Shows | Changed by | Request |
|---|---|---|---|
| **Size** *(needs shut off)* | CPU cores, memory | Edit: a preset or custom cores and memory | `PATCH /api/vms/:name` `{ vcpus, memoryMiB }` |
| **Disks and media** | Each disk: size and image. Each CD: its ISO | Disk *(needs shut off)*: Add, Edit (size, bus), Remove. CD, at any time: Insert, Change, Eject | The disk and CD routes ([API-VMS.md](API-VMS.md)) |
| **Network** *(needs shut off)* | Each adapter: bridge and address | Add, Edit (bridge, MAC, model), Remove | `PATCH` `{ nics }`, the whole list |
| **First boot setup** (a VM whose profile has it) | Host name, user, whether a password is set, the SSH keys by name, package update | Edit; Remove | `PUT` and `DELETE /api/vms/:name/cloudinit` |
| **USB devices** | The devices passed through | Attach, Detach, at any time | The USB routes |
| **Start-up** | — | A switch: start with the host | `PATCH` `{ autostart }` |
| **System** *(needs shut off)* | The profile, and in one line what it set | Expert settings; View XML | `PATCH` with the settings changed |

- **Rename** *(needs shut off)* asks for the new name in a small dialog and sends
  `PATCH` `{ name }`; the page then moves to the new name.
- **First boot setup**: an empty host name means the VM's name as it is now. SSH keys are
  picked from Wisp's list ([SETTINGS.md](SETTINGS.md)); a key pasted here is added to
  that list. The password field is empty and keeps the stored one unless typed.
- **Expert settings** holds, grouped: boot (order, menu); firmware and machine (firmware,
  machine type, CPU model, nested virtualisation); display (video, console protocol);
  integration (guest agent, memory balloon, random number device, TPM); and the
  operating system the Windows tuning follows.

## States

- A group whose data is loading shows a skeleton; one whose read failed shows the error
  with Retry ([UI.md](UI.md)).
- An empty list says so in a line ("None attached.").
- A form's Save is busy until the server answers; a failure shows in the form, which
  stays open. An action's failure shows in the page's error display.
- While a job runs on the VM (a backup, a start), what the server would refuse is
  disabled and says which job.

## New VM

One form, its own page:

| Field | Notes |
|---|---|
| Name | |
| Runs | Linux image, Linux installer, Windows 11, Other: the profile |
| Image | A cloud image or an ISO from the library, by what "Runs" needs |
| Size | Small (2 cores, 2 GB), Medium (2, 4), Large (4, 8), or custom |
| Disk | Size in GB |
| User, SSH keys | For a Linux image. The default keys are preselected |

Create sends `POST /api/vms` with the profile's name and these values; the server fills
in the rest from the profile ([VM-MANAGEMENT.md](VM-MANAGEMENT.md)). On success the page
opens the new VM, if the user is still on the form.

## Phones

The same groups in one column. The figures are centred, in two rows. A form opens as a
sheet from the bottom. Every action stays visible: none hides behind a hover.
