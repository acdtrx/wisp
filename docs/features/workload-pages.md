# View, edit, act: simpler pages for the whole app

Replaces phase 6 of `docs/reviews/2026-11-17/IMPLEMENTATION.md`. The picture of it is
`workload-pages-mockup.html`, beside this file (agreed 2026-11-21). Where the mockup and
the page specs differ, the specs hold: the mockup was drawn first.

## What it is for

Wisp is for people who do not need Proxmox: run a Linux or Windows VM, run a container,
reach them on the network. Today a VM or container page is a stack of forms that are
open all the time, each with its own Save, while the server changes the values under
them. Phase 4 showed what that costs: most of its review rounds went into forms that are
also live views. The create panels reuse those forms in a second mode, and the VM page
offers a dozen technical settings almost nobody changes.

This feature gives the pages one model and puts the settings in the order people use
them.

## Decisions

### The model: three shapes and no others

- **View.** A page shows the server's state, live. Values are text, not inputs.
- **Edit.** A group of settings has one Edit. It opens a small form holding the values as
  they were when it opened; Save sends that group in one request and closes the form.
  Nothing else on a page waits for a Save.
- **Act.** A switch or a button on the page acts at once, in one request.

The same three hold for the whole app, not only the workload pages. What goes: forms on
a page, per-section Save and "unsaved" state, the form hook, and the create panels'
second mode of the detail sections.

- **A group that needs the workload stopped** (the lock rule of 2026-11-21) has its Edit
  and Add disabled, with a small lock by the group's title that says why.
- **A change that applies at the next start** is saved at once, and the header says
  "Restart to apply", as today.
- **Every action is an icon** with its name on hover, as today. Only a form's Save and
  Cancel are text.

### What sits where

- Groups are ordered by how often people change them, and settings of one kind share a
  group. The pages: `specs/UI-VM.md` and `specs/UI-CONTAINER.md`, written with this
  feature.
- The header keeps Start, Stop and Restart. Pause, Force stop, Rename, Change icon,
  Back up now and Delete are in a "More" menu.
- The stats bar at the bottom becomes a row of figures at the top of the page, each in a
  cell of fixed width.

### The operating system picks a VM's technical settings

- **A VM has a profile**: Linux, Windows 11, or Other. The profile sets firmware, machine
  type, disk bus, TPM, the Windows tuning and whether first boot setup applies. The
  server holds the profiles, in one table; the create form sends the profile's name and
  the server fills in the rest. (The server already has a `template` field that does
  part of this; the form has never sent it.)
- **The VM remembers its profile.** A migration gives each existing VM one, from what its
  definition holds. Today the page guesses "Windows" from the VM's name containing
  "win".
- **The Advanced section goes.** The page's System group shows the profile and, in one
  line, what it set. "Expert settings" opens every one of today's Advanced settings in a
  form, grouped. None is removed from the server.

### Creating

- **New VM is its own form**: name, what it runs, the image, size, disk, and for a Linux
  image the user and SSH keys. Size is a preset (Small, Medium, Large) or custom.
- **New container** stays the two fields it is (name and image, or an app), as its own
  form.

### SSH keys live in Wisp's settings

- Wisp keeps a list of SSH public keys, each with a name, and one or more marked as the
  default for new VMs. A key is added by pasting it (its name is the key's own comment,
  or a generic one) or by importing a GitHub user's keys.
- A VM's first boot setup picks from that list. A key pasted there is saved to the list
  too. A VM keeps its own copy of the keys it was given: removing a key from the list
  changes no VM.
- First boot setup takes several keys. The server already does; the form took one.

### The specs

- `specs/UI.md` (636 lines) is split. It keeps what is common: the shell, the top bar,
  the sidebar, sign-in, the shared components. Each area gets a file of its own, written
  fresh and short as that area is rebuilt: `UI-VM.md`, `UI-CONTAINER.md`, then
  `UI-HOST.md`. The old text of an area is removed when its file lands, not edited.
- The design session writes these files and the user agrees them. The builder does not
  edit specs or rule docs.

## Behaviour changes

- Workload pages no longer have forms with Save buttons; each group is edited in a small
  form.
- A VM's technical settings are behind "Expert settings".
- New VM asks for a profile, a size and a disk instead of showing every section.
- First boot setup takes several SSH keys, picked from Wisp's list.
- An app container's rows (a Caddy site, a Samba share) are saved one at a time. Removing
  a Samba share asks about its data when it is removed, not at a later Save (this
  replaces the 2026-10-16 rule, which rested on the section Save).
- "Regenerate ISO" for first boot setup goes: saving the setup rebuilds it.
- Environment is not shown for an app container: the app owns its variables (the server
  already refuses an edit there).

## What it changes on the server

- The profiles table, used by create; the profile stored on the VM, with its migration.
- The SSH key list in the settings file, with routes to list, add, import and remove a
  key and to mark a default.
- Nothing else. Every group's Edit uses a request that exists today.

## Constraints

- No new dependency.
- A page and its forms are built from the shared pieces phase 4 left: records, the editor
  hook, the command hook, the one error display.
- The pages work on a phone as on a desktop: the same groups, forms as a sheet from the
  bottom.

## Milestones

Each is built by one builder, observed by running it, and reviewed once for defects a
user would hit.

### 1. The container page

- A plain container and each of the four app containers show the groups of
  `specs/UI-CONTAINER.md`, in its order, in light, dark and at phone width.
- Every Edit, Add and Remove on the page sends the one request the spec names, and the
  page then shows the new value without a reload.
- With the container running, Rename and the network Edit are disabled and say why;
  every other group can be edited, and a change that needs a restart shows "Restart to
  apply".
- No form with a Save button is left on the page, and the container sections' create
  mode is gone from the code.

### 2. The VM page

- A Linux VM and a Windows VM show the groups of `specs/UI-VM.md`, in its order, in
  light, dark and at phone width.
- Every Edit, Add and Remove sends the one request the spec names, and the page then
  shows the new value without a reload.
- With the VM running, the groups that need it shut off are disabled and say why; CD and
  USB actions still work.
- Expert settings holds every setting the Advanced section had, and saving one changes
  the VM as it did.
- No form with a Save button is left on the page.

### 3. Profiles and the create forms

- New VM creates a Linux VM from a cloud image, a Linux VM from an installer ISO and a
  Windows 11 VM, each with the settings its profile names, checked on the test host in
  the VM's definition.
- Each existing VM shows a profile after the update, and its definition is otherwise
  unchanged (compared before and after on the test host).
- New container creates a plain container and an app container.
- The old create panels and the detail sections' create mode are gone from the code.

### 4. SSH keys

- A key can be pasted, imported from GitHub, marked default and removed on the settings
  page.
- New VM preselects the default keys; a VM created with two keys accepts a login with
  either (test host).
- A key pasted in first boot setup appears in the list.

### 5. The settings and host forms

The rest of the app was checked on 2026-11-21 for forms that are open all the time. There
are four, all with a Save button: App Config, Backup, the backup Scheduler, and Sign-in
(SSO). Everything else already has one of the three shapes: tables with row forms (SMB
shares, drives, bridges, tokens, home links), actions that run at once (updates,
restores, uploads), and a name typed in place (an image, a sidebar section, a home
tile).

- Each of the four shows its values as text, with one Edit that opens its form.
  `specs/UI-HOST.md` is written for these pages first.
- The mount file editor reads the file when it opens, like every other editor.
- The form hook and its value logic are deleted: nothing calls them. The frontend then
  has three mechanisms for server state: a record to view, an editor to edit, a command
  to act.

## Not in this feature

- Scheduled backups for VMs (only containers have them today; left out on the user's
  decision of 2026-11-21, though the mockup shows the switch).
- A route to pull a new image and restart in one step: "Update available" is applied by
  Restart, as today.
- The primitives and renames phase 6 listed (Button, IconButton, Badge, Tabs, Field):
  the new pages are written with what exists; a pass over the rest of the app is
  decided after this feature.
