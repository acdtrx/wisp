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
| `sshKeySource` | string | How the key was obtained (e.g. `github:username` or `manual`) |
| `growPartition` | boolean | Whether to grow the root partition to fill the disk |
| `packageUpgrade` | boolean | Whether to run `apt upgrade` (or equivalent) on first boot |
| `installQemuGuestAgent` | boolean | Whether to install `qemu-guest-agent` on first boot (default true) |
| `installAvahiDaemon` | boolean | Whether to install `avahi-daemon` on first boot (default true) |

## Seed ISO Generation

The seed ISO contains two files:
- **user-data** — YAML cloud-init configuration (users, SSH keys, packages, etc.). When `installQemuGuestAgent` or `installAvahiDaemon` is enabled, a `packages:` list is added so cloud-init installs those packages on first boot.
- **meta-data** — YAML with instance ID and hostname

### Password hashing

Passwords are hashed using `openssl passwd -6` (SHA-512 crypt) before being written to the user-data YAML. The plaintext password is never stored in the ISO — only the hash.

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

When `cloudInit.enabled` is `false`, creation **skips** cloud-init: no ISO, no `cloud-init.json`, and no `sde` in the domain XML.

### Read

`GET /api/vms/:name/cloudinit` returns the stored configuration when `cloud-init.json` exists (including when `enabled` is `false` after a soft-disable). The password field is returned as `"set"` when a password is on file, or empty when not set (never the plaintext or hash). When there is **no** `cloud-init.json`, the response is the placeholder `{ enabled: false }` only.

### Update

`PUT /api/vms/:name/cloudinit` with **`enabled: true`** (or omitted, treated as on):
1. Save the new config to `cloud-init.json`
2. Re-hash the password (if changed)
3. Regenerate the seed ISO
4. Attach/update `sde` in the domain XML

`PUT` with **`enabled: false`** (soft-disable):
1. Detach/eject `sde` and delete `cloud-init.iso`
2. Save `cloud-init.json` with `enabled: false` and the submitted fields merged into the stored config (so settings are kept for re-enabling)

A notice is displayed in the UI: changes take effect on next boot if cloud-init has already run inside the guest.

### Disable (full removal)

`DELETE /api/vms/:name/cloudinit`:
1. Detach `sde` from the domain XML
2. Delete `cloud-init.iso`
3. Delete `cloud-init.json`

The Cloud-Init section in the UI then shows a way to configure again from scratch.

### Regenerate

Rebuild the seed ISO from the current stored configuration without opening the edit form. Useful after making manual changes to `cloud-init.json`.

## GitHub SSH Key Import

SSH keys can be imported from a GitHub user profile:

1. User enters a GitHub username in the UI
2. Frontend sends `GET /api/github/keys/:username`
3. Backend fetches `https://github.com/<username>.keys` server-side (no direct browser-to-GitHub request — prevents CORS issues and SSRF from the frontend)
4. Returns the list of SSH public keys
5. User confirms which key(s) to use
6. Selected key is written to the `sshKey` field with `sshKeySource: "github:<username>"`

## Visibility Rules

### By OS type

- **Linux VMs** — Cloud-init section is always visible
- **Windows VMs** — Cloud-init section is hidden (Windows does not use cloud-init)
- **HAOS (Home Assistant OS)** — Cloud-init section is hidden during creation

### By disk type (Create VM only)

During VM creation:
- **Existing Image** disk type — Cloud-init section is visible (cloud images support cloud-init)
- **New Disk** disk type — Cloud-init section is hidden (bare disks need an OS installation first)

### Overview vs. Create

| Context | Behavior |
|---------|----------|
| **Create VM** (`isCreating=true`) | Full editable form: a **Cloud Init** master toggle (first in the toggle row, default on) gates whether cloud-init runs for this VM; when off, other fields are disabled and creation skips the seed ISO. |
| **Overview** (`isCreating=false`) | Read-only summary includes Cloud Init on/off, hostname, username, masked password, SSH key status, and option toggles. Edit opens the full form; save with Cloud Init off performs a soft-disable (ISO removed, json kept). **Remove** performs full removal (same as `DELETE`). |
