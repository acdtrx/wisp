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

**`installAvahiDaemon` is how a guest announces itself** *(settled 2026-11-20)*. Wisp publishes no `.local` name for a VM ([VM-MANAGEMENT.md → Local DNS](VM-MANAGEMENT.md#local-dns-mdns)): a Linux guest gets one by running avahi-daemon, which announces the guest's own hostname (the `hostname` above) on the LAN. So the option stays on by default. A guest made without it installs avahi itself; Windows and macOS guests announce their own names.

## Seed ISO Generation

The seed ISO contains two files:
- **user-data** — YAML cloud-init configuration (users, SSH keys, packages, etc.). When `installQemuGuestAgent` or `installAvahiDaemon` is enabled, a `packages:` list is added so cloud-init installs those packages on first boot. When `installQemuGuestAgent` is enabled, a `runcmd:` entry also runs `systemctl enable --now qemu-guest-agent` after package install — the unit's `BindsTo=` the virtio-port device, and the device-binding window passes before cloud-init's package install finishes, so the postinst alone leaves the unit disabled-and-stopped (libvirt then never sees the agent connect, even across in-guest reboots).
- **meta-data** — YAML with instance ID and hostname. The instance ID is **`<vmName>-<sha256(user-data) prefix 12 chars>`**, not just `<vmName>`. cloud-init gates nearly every module (`users`, `set_passwords`, `ssh_authkey_fingerprints`, `runcmd`, `package_update_upgrade_install`, `write_files`, `bootcmd`) on instance ID with frequency `once-per-instance` — a stable instance ID makes every config change a silent no-op on already-booted VMs. Hashing the user-data means an unchanged config preserves the ID (no surprise re-runs), while any edit (password, SSH key, packages, hostname, runcmd) produces a fresh ID and cloud-init re-applies on the next boot. Module re-runs are idempotent for our generated user-data (apt is no-op for already-installed packages, `systemctl enable --now` is idempotent, user creation/password set just rewrites).

### Password hashing

Passwords are hashed using `openssl passwd -6` (SHA-512 crypt) before being written to the user-data YAML. The plaintext password is never stored on disk; the SHA-512 crypt hash is persisted in `cloud-init.json` as **`passwordHash`** so subsequent saves can re-emit the same hash without re-hashing.

The generated `cloud-init.iso` is `chmod 0600` after creation. It bakes in user-data containing the crypt hash, and the per-VM directory is group-readable (`wisp:libvirt 0775`), so `0600` keeps the credential out of group/other reach. libvirt re-chowns the ISO to its qemu user when the VM starts, so the running guest can still read it.

Every file holding the hash gets the same treatment: `cloud-init.json` is written `0600` (and chmodded on every save; files written earlier are tightened on update by state migration `0003-cloud-init-json-mode`); the ISO's build inputs live in a `mkdtemp` directory (`0700`, unpredictable name) with `user-data` written `0600`, removed after the build; backups hold `cloud-init.json` (`0600`) but never the ISO — a backup restore chmods the restored JSON to `0600` and rebuilds the ISO from it (see [BACKUPS.md → Cloud-init seed ISO](BACKUPS.md#cloud-init-seed-iso)). Clone copies both files with the source's mode.

**Placeholder semantics.** The API never returns the plaintext or hash; `password` is exposed to clients as `"set"` (or empty). When a client sends `password` back as `"set"` (what `GET` returns) or `"***"` (the placeholder `cloud-init.json` stores), the backend treats it as **"leave password unchanged"** and re-uses the stored `passwordHash`; an empty `password` means no password. The Overview edit form leaves the field blank ("Leave blank to keep unchanged") and sends `"set"` for a blank field when a password is on file (settled 2026-11-12). Re-hashing the literal placeholder string would silently downgrade the VM password — explicitly avoided.

**Dual emission (`users[].passwd` + `chpasswd`).** cloud-init's `cc_users_groups` module only applies `passwd:` on user *creation* — for an existing user it logs "already exists, skipping" and leaves the password untouched, even when a fresh instance-id forces the module to re-run. The user-data therefore also emits a top-level `chpasswd:` block (cc_set_passwords module) which runs `chpasswd -e` against existing accounts unconditionally. The two are complementary: `users[].passwd` covers the first-boot creation path, `chpasswd` covers every subsequent password edit. `expire: false` is set on `chpasswd` so the user isn't prompted to change the password on first login.

### YAML emission

`user-data` and `meta-data` are produced by **js-yaml** (`yaml.dump`), not template literals. Every scalar is automatically quoted/escaped, so user-controlled fields cannot inject sibling YAML keys (e.g. `runcmd:` / `write_files:` / `packages:`). Input fields also have route-level regex constraints as defense in depth:

| Field | Regex / limit |
|-------|---------------|
| `hostname` | `^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$` (RFC 1123 label, ≤ 63 chars) |
| `username` | `^[a-z][a-z0-9_-]{0,31}$` |
| `password` | `^[^\r\n]*$`, ≤ 256 chars (CR/LF rejected) |
| `sshKey` | ≤ 16384 chars; split on newlines into individual key entries |

### ISO creation tools

Two tools are supported, in priority order:

1. **`cloud-localds`** (from `cloud-image-utils`) — the preferred tool. Generates a valid cloud-init NoCloud datasource ISO directly from user-data and meta-data files.

2. **`genisoimage`** — fallback when `cloud-localds` is not available. Creates an ISO with volume label `cidata`, Joliet and Rock Ridge extensions: `genisoimage -V cidata -r -J -o <output> <input-dir>/`

Both tools are invoked via `child_process`.

## Per-VM Storage

Cloud-init files are stored in the VM's directory:

```
<vmsPath>/<vm-name>/
├── cloud-init.iso        # The seed ISO attached to sde
└── cloud-init.json       # The configuration (for later editing/regeneration)
```

The `cloud-init.json` file stores the configuration fields so the UI can display the current config and support editing/regeneration.

## Disk Slot

Cloud-init uses slot `sde`:

```xml
<disk type='file' device='cdrom'>
  <source file='/var/lib/wisp/vms/<name>/cloud-init.iso'/>
  <target dev='sde' bus='sata'/>
  <readonly/>
</disk>
```

## Operations

### Create (during VM creation)

When creating a VM with cloud-init **enabled** (`cloudInit.enabled` not `false`; omitted counts as on):
1. Generate the seed ISO from the provided config
2. Save the config as `cloud-init.json` (with `enabled: true`)
3. The VM domain XML includes `sde` pointing to the ISO

Both files are written only **after** the name is known to be free in libvirt and on disk, into the VM directory `createVM` has just created: the route passes `generateCloudInit` to `createVM` as its `populateVMDir` callback. A create whose name belongs to an existing VM or a kept directory is refused (409 `VM_EXISTS` / `VM_DIR_EXISTS`, see [VM-MANAGEMENT.md](VM-MANAGEMENT.md#creation-flow)) before anything is generated, so it can never touch that VM's `cloud-init.iso` / `cloud-init.json`; a create that fails later removes the whole new directory, cloud-init files included.

When `cloudInit.enabled` is `false`, creation **skips** cloud-init: no ISO, no `cloud-init.json`, and no `sde` in the domain XML.

### Read

`GET /api/vms/:name/cloudinit` returns the stored configuration when `cloud-init.json` exists (including when `enabled` is `false` after a soft-disable). The password field is returned as `"set"` when a password hash is on file, or empty when not (never the plaintext or hash). When there is **no** `cloud-init.json`, the response is the placeholder `{ enabled: false }` only.

### Update

`PUT /api/vms/:name/cloudinit` with **`enabled: true`** (or omitted, treated as on):
1. Save the new config to `cloud-init.json`
2. Re-hash the password (if changed)
3. Regenerate the seed ISO
4. Attach/update `sde` in the domain XML

`PUT` with **`enabled: false`** (soft-disable):
1. Save `cloud-init.json` with `enabled: false` and the submitted fields merged into the stored config (so settings are kept for re-enabling) — except `password`: a disabled config takes no new password, and the stored hash stays as it was (settled 2026-11-12)
2. Detach/eject `sde` and delete `cloud-init.iso`

A notice is displayed in the UI: changes take effect on next boot if cloud-init has already run inside the guest.

### Disable (full removal)

`DELETE /api/vms/:name/cloudinit`:
1. Delete `cloud-init.json`
2. Detach `sde` from the domain XML
3. Delete `cloud-init.iso`

The Cloud-Init section in the UI then shows a way to configure again from scratch.

**The json goes first** (settled 2026-11-16), in soft-disable and in removal: detaching `sde` makes every tab re-read the VM, and that re-read must find the new cloud-init state, not the old "On". Accepted cost: if the detach fails after a removal deleted the json, the VM keeps an ISO with no config behind it; the section offers to configure from scratch, and a new save replaces the ISO. The same for a soft-disable: if its detach fails, the summary shows Off while the ISO stays attached until a soft-disable is saved again (settled 2026-11-16).

### Regenerate

The server can rebuild the seed ISO from the stored configuration, for use after a manual change to `cloud-init.json`. The page no longer offers it (settled 2026-11-21): saving first boot setup rebuilds the ISO.

A backup restore (always as a new VM) rebuilds the ISO the same way, from the restored `cloud-init.json` (`rebuildCloudInitISO`, the stored password hash reused); backups don't carry the ISO. See [BACKUPS.md → Cloud-init seed ISO](BACKUPS.md#cloud-init-seed-iso).

The generator unlinks any existing `cloud-init.iso` before invoking `cloud-localds` / `genisoimage`. libvirt's `dynamic_ownership` chowns the file to `libvirt-qemu:kvm` on VM start and only chowns it back on a clean stop, so without the unlink a regenerate after the VM has run (especially after a force-stop or crash) hits `EACCES` trying to truncate a file the wisp user no longer owns. Per-VM directories are `wisp:libvirt 0775`, which grants unlink regardless of file ownership; the freshly created ISO is owned by the wisp user and libvirt re-chowns it on the next start.

## SSH keys

A VM's first boot setup holds its own copy of its public keys, in `sshKey`, one per line.
They are picked from Wisp's list of keys ([SETTINGS.md](SETTINGS.md), SSH keys), where a
GitHub user's keys are imported too; a key pasted in the setup is added to that list. A
VM takes at most 16384 characters of keys. The
setup does not record where a key came from (settled 2026-11-21: `sshKeySource` left the
stored shape, by migration `0013`).

## Visibility Rules

### By OS type

- **Linux VMs** — Cloud-init section is always visible
- **By profile** — whether a VM takes first boot setup is its profile's ([VM-MANAGEMENT.md](VM-MANAGEMENT.md), Profiles): only `linux` does. The page shows the group for those VMs only, and the server refuses a setup for the others
- **HAOS (Home Assistant OS)** — Cloud-init section is hidden during creation

### By disk type (Create VM only)

During VM creation:
- **Existing Image** disk type — Cloud-init section is visible (cloud images support cloud-init)
- **New Disk** disk type — Cloud-init section is hidden (bare disks need an OS installation first)

### Overview vs. Create

| Context | Behavior |
|---------|----------|
| **New VM** | For a Linux image the form asks for the user, a password and the SSH keys, picked from Wisp's list with the default ones preselected. The host name is derived from the VM's name and package update is off; the other options are on ([UI-VM.md](UI-VM.md), New VM). |
| **The VM page** | The First boot setup group ([UI-VM.md](UI-VM.md)): its values as text, an Edit that saves with the setup on, and a Remove that asks first (same as `DELETE`). The page has no on/off: a stored setup that is switched off shows "Off" until it is saved again (settled 2026-11-21). |

## Timeouts

(settled 2026-11-12, CODING-RULES §6.) The GitHub keys lookup ([SETTINGS.md](SETTINGS.md), SSH keys) **10 s**, its DNS lookups, redirects and body included; the password hash (`openssl passwd`) **10 s**; the seed ISO build **20 s** (settled 2026-11-13).
