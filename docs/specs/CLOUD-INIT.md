# Cloud-Init

Cloud-init provides automated VM provisioning: setting hostname, creating users, configuring SSH keys, and running initial setup tasks. Wisp generates a cloud-init seed ISO that is attached as a virtual CDROM (slot `sde`), which cloud-init inside the guest reads on first boot.

## Configuration Fields

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Whether cloud-init is active for this VM (default **on**). When off, no seed ISO is generated or attached; `cloud-init.json` may still hold settings for re-enabling (see PUT vs DELETE). |
| `hostname` | string | Guest hostname |
| `username` | string | User account to create in the guest |
| `password` | string | User password (hashed before writing to ISO) |
| `sshKey` | string | SSH public key(s) to authorize for the user |
| `growPartition` | boolean | Whether to grow the root partition to fill the disk |
| `packageUpgrade` | boolean | Whether to run `apt upgrade` (or equivalent) on first boot |
| `installQemuGuestAgent` | boolean | Whether to install `qemu-guest-agent` on first boot (default true) |
| `installAvahiDaemon` | boolean | Whether to install `avahi-daemon` on first boot (default true): the way a Linux guest gets its `.local` name, which it then announces itself — see below |

**`installAvahiDaemon` is how a guest announces itself** *(settled 2026-11-20)*. Wisp publishes no `.local` name for a VM ([VM-MANAGEMENT.md → Local DNS](VM-MANAGEMENT.md#local-dns-mdns)): a Linux guest gets one by running avahi-daemon, which announces the guest's own hostname (the `hostname` above) on the LAN. So the option stays on by default.

## Seed ISO Generation

The seed ISO contains two files:
- **user-data** — YAML cloud-init configuration (users, SSH keys, packages, etc.). When `installQemuGuestAgent` or `installAvahiDaemon` is enabled, cloud-init installs that package on first boot. For the guest agent it also enables and starts the unit after the install, because the package's own install leaves it stopped.
- **meta-data** — YAML with instance ID and hostname. The instance ID is **`<vmName>-<sha256(user-data) prefix 12 chars>`**, not just `<vmName>`: cloud-init runs nearly every module once per instance ID, so an unchanged config keeps the ID (no surprise re-runs), while any edit (password, SSH key, packages, hostname) produces a fresh ID and cloud-init re-applies on the next boot.

### Password hashing

Passwords are hashed using `openssl passwd -6` (SHA-512 crypt) before being written to the user-data YAML. The plaintext password is never stored on disk; the SHA-512 crypt hash is persisted in `cloud-init.json` as **`passwordHash`** so subsequent saves can re-emit the same hash without re-hashing.

Every file holding the hash is `0600`: the generated `cloud-init.iso` (the per-VM directory is group-readable); `cloud-init.json`, set on every save; and the ISO's build inputs, which live in a private temporary directory removed after the build. Backups hold `cloud-init.json` (`0600`) but never the ISO — a backup restore creates the restored JSON `0600` and rebuilds the ISO from it (see [BACKUPS.md → Cloud-init seed ISO](BACKUPS.md#cloud-init-seed-iso)).

**Placeholder semantics.** The API never returns the plaintext or hash; `password` is exposed to clients as `"set"` (or empty). When a client sends `password` back as `"set"` (what `GET` returns) or `"***"` (the placeholder `cloud-init.json` stores), the backend treats it as **"leave password unchanged"** and re-uses the stored `passwordHash`; an empty `password` means no password. The edit form leaves the field blank ("Leave blank to keep unchanged") and sends `"set"` for a blank field when a password is on file (settled 2026-11-12).

**A password edit reaches an existing user.** The user-data sets the password both where the user is created and for an account that already exists, so an edit applies on the next boot; the user is not asked to change it at first login.

### YAML emission

`user-data` and `meta-data` are produced by a YAML serializer, not template literals. Every scalar is quoted and escaped, so user-controlled fields cannot inject sibling YAML keys (e.g. `runcmd:` / `write_files:` / `packages:`). Input fields also have route-level constraints as defense in depth:

| Field | Regex / limit |
|-------|---------------|
| `hostname` | `^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$` (RFC 1123 label, ≤ 63 chars) |
| `username` | `^[a-z][a-z0-9_-]{0,31}$` |
| `password` | `^[^\r\n]*$`, ≤ 256 chars (CR/LF rejected) |
| `sshKey` | ≤ 16384 chars; split on newlines into individual key entries |

## Per-VM Storage

Cloud-init files are stored in the VM's directory `<vmsPath>/<vm-name>/`: `cloud-init.iso`, the seed ISO attached as the CD-ROM in slot `sde`, and `cloud-init.json`, the configuration, kept for later editing.

## Operations

### Create (during VM creation)

When creating a VM with cloud-init **enabled** (`cloudInit.enabled` not `false`; omitted counts as on), the seed ISO is generated from the provided config, the config is saved as `cloud-init.json` (with `enabled: true`), and the VM's definition has `sde` pointing to the ISO.

Both files are written only **after** the name is known to be free in libvirt and on disk, into the VM directory the create has just made. A create whose name belongs to an existing VM or a kept directory is refused (409 `VM_EXISTS` / `VM_DIR_EXISTS`, see [VM-MANAGEMENT.md](VM-MANAGEMENT.md#creation-flow)) before anything is generated, so it can never touch that VM's `cloud-init.iso` / `cloud-init.json`; a create that fails later removes the whole new directory, cloud-init files included.

When `cloudInit.enabled` is `false`, creation **skips** cloud-init: no ISO, no `cloud-init.json`, and no `sde` in the domain XML.

### Read

`GET /api/vms/:name/cloudinit` returns the stored configuration when `cloud-init.json` exists (including when `enabled` is `false` after a soft-disable). The password field is returned as `"set"` when a password hash is on file, or empty when not (never the plaintext or hash). When there is **no** `cloud-init.json`, the response is the placeholder `{ enabled: false }` only.

### Update

`PUT /api/vms/:name/cloudinit` with **`enabled: true`** (or omitted, treated as on):
1. Save the new config to `cloud-init.json`
2. Re-hash the password (if changed)
3. Regenerate the seed ISO
4. Attach/update `sde` in the domain XML. A VM made without first boot setup has no `sde` slot: the slot is added to the saved definition, whatever the VM's state, and a VM that is on shows "restart required" (a SATA CD-ROM cannot be hot-plugged, and the seed is read at the next boot). A failed attach fails the save with its error (settled 2026-11-22).

`PUT` with **`enabled: false`** (soft-disable):
1. Save `cloud-init.json` with `enabled: false` and the submitted fields merged into the stored config (so settings are kept for re-enabling) — except `password`: a disabled config takes no new password, and the stored hash stays as it was (settled 2026-11-12)
2. Detach/eject `sde` and delete `cloud-init.iso`

An edit takes effect on the guest's next boot.

### Disable (full removal)

`DELETE /api/vms/:name/cloudinit`:
1. Delete `cloud-init.json`
2. Detach `sde` from the domain XML
3. Delete `cloud-init.iso`

**The json goes first** (settled 2026-11-16), in soft-disable and in removal: detaching `sde` makes every tab re-read the VM, and that re-read must find the new cloud-init state, not the old "On". Accepted cost: if the detach fails after a removal deleted the json, the VM keeps an ISO with no config behind it; the section offers to configure from scratch, and a new save replaces the ISO. The same for a soft-disable: if its detach fails, the summary shows Off while the ISO stays attached until a soft-disable is saved again (settled 2026-11-16).

### Regenerate

The page offers no Regenerate (settled 2026-11-21): saving first boot setup rebuilds the ISO.

A backup restore (always as a new VM) rebuilds the ISO from the restored `cloud-init.json`, the stored password hash reused; backups don't carry the ISO. See [BACKUPS.md → Cloud-init seed ISO](BACKUPS.md#cloud-init-seed-iso).

## SSH keys

A VM's first boot setup holds its own copy of its public keys, in `sshKey`, one per line.
They are picked from Wisp's list of keys ([SETTINGS.md](SETTINGS.md), SSH keys), where a
GitHub user's keys are imported too; a key pasted in the setup is added to that list. A
VM takes at most 16384 characters of keys. The
setup does not record where a key came from (settled 2026-11-21).

## Visibility Rules

Whether a VM takes first boot setup is its profile's ([VM-MANAGEMENT.md](VM-MANAGEMENT.md), Profiles): only `linux` does. The page shows the group for those VMs only, and the server refuses a setup for the others.

### Overview vs. Create

| Context | Behavior |
|---------|----------|
| **New VM** | For a Linux image the form asks for the user, a password and the SSH keys, picked from Wisp's list with the default ones preselected. The host name is derived from the VM's name and package update is off; the other options are on ([UI-VM.md](UI-VM.md), New VM). |
| **The VM page** | The First boot setup group ([UI-VM.md](UI-VM.md)): its values as text, an Edit that saves with the setup on, and a Remove that asks first (same as `DELETE`). The page has no on/off: a stored setup that is switched off shows "Off" until it is saved again (settled 2026-11-21). |

## Timeouts

(settled 2026-11-12, CODING-RULES §6.) The GitHub keys lookup ([SETTINGS.md](SETTINGS.md), SSH keys) **10 s**, its DNS lookups, redirects and body included; the password hash (`openssl passwd`) **10 s**; the seed ISO build **20 s** (settled 2026-11-13).
