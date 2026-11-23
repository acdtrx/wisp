# UI: the VM page

What a VM's page shows and how each thing on it is changed. The shell, the sidebar and
the shared components are in [UI.md](UI.md); the three shapes (view, edit, act) are in
`FRONTEND-RULES.md`, Data. Settled 2026-11-21.

## The page

- **Header**: the VM's icon and name, its state, and the tabs Overview and Console.
  Actions, as icons: Start when it is stopped; Stop and Restart when it runs. A "More"
  menu holds Pause or Resume, Force stop, Rename, Change icon, Back up now and Delete.
  Restart reboots the guest, which keeps the running settings: so while a saved change
  waits (or the host's QEMU was replaced) the header says "Stop and start to apply".
  Back up now needs the VM shut off.
- **Figures**, in a row under the header while the VM runs: address, host name, uptime,
  CPU, disk and network rates, as the stats stream carries them. Each sits in a cell of
  fixed width. Stopped or paused, the row says so ("Stopped", "Paused").
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
| **Disks and media** | Each disk: size and image. Each CD: its ISO | Disk *(needs shut off)*: Add (with its bus), Edit (size; the bus is shown), Remove. CD, at any time: Insert, Change, Eject | The disk and CD routes ([API-VMS.md](API-VMS.md)) |
| **Network** *(needs shut off)* | Each adapter: bridge, model and MAC (the address is in the figures) | Add, Edit (bridge, MAC, model), Remove | `PATCH` `{ nics }`, the whole list |
| **First boot setup** (a VM whose profile has it) | Host name, user, whether a password is set, the SSH keys by name, the options; "Off" for a stored setup that is switched off, "Not set up." for none | Edit (which turns it on); Remove, which asks first | `PUT` and `DELETE /api/vms/:name/cloudinit` |
| **USB devices** | The devices passed through | Attach, Detach, at any time | The USB routes |
| **Start-up** | — | A switch: start with the host | `PATCH` `{ autostart }` |
| **System** | The profile ("Unknown" for a VM Wisp neither created nor migrated), and in one line what it set | Expert settings *(needs shut off)*; View XML, at any time | `PATCH` with the settings changed |

- **Rename** *(needs shut off)* asks for the new name in a small dialog and sends
  `PATCH` `{ name }`; the page then moves to the new name.
- **A disk's Remove** detaches it; its file stays in the VM's folder. The last adapter
  cannot be removed.
- **First boot setup**: its form also holds the options (grow the disk, install the guest
  agent, announce a local name, update packages). An empty host name means the VM's name as it is now. SSH keys are
  picked from Wisp's list ([SETTINGS.md](SETTINGS.md)); a key pasted here is added to
  that list. A key the VM holds that is not in the list shows as a row of its own, and
  stays unless it is unchecked. The password field is empty and keeps the stored one unless typed.
- **Expert settings** holds, grouped: boot (order, menu); firmware and machine (firmware and
  machine type, shown and not edited: they are set at create; CPU model, nested
  virtualisation); display (video, console protocol);
  integration (guest agent, memory balloon, random number device, TPM); and the
  operating system the Windows tuning follows.

## States

As on every workload page ([UI.md](UI.md#workload-pages)).

## New VM

One form, its own page:

| Field | Notes |
|---|---|
| Name | |
| Runs | Linux image, Linux installer, Windows 11, Other: the profile |
| Image | A cloud image or an ISO from the library, by what "Runs" needs |
| Size | Small (2 cores, 2 GB), Medium (2, 4), Large (4, 8), or custom |
| Disk | Size in GB |
| Drivers | For Windows 11: an ISO attached as a second CD, preselected with the library's `virtio-win` file, and it can be cleared |
| User, password, SSH keys | For a Linux image. The keys are picked from Wisp's list, the default ones preselected; a key can be pasted, which adds it to the list |

A Linux image gets first boot setup with the host name derived from the VM's name and
package update off; both can be changed on the page afterwards.

Create sends `POST /api/vms` with the profile's name and these values; the server fills
in the rest from the profile ([VM-MANAGEMENT.md](VM-MANAGEMENT.md)). On success the page
opens the new VM, if the user is still on the form.

## Phones

As on every workload page ([UI.md](UI.md#workload-pages)).
