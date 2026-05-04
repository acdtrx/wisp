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
- **user-data** — YAML cloud-init configuration (users, SSH keys, packages, etc.). When `installQemuGuestAgent` or `installAvahiDaemon` is enabled, a `packages:` list is added so cloud-init installs those packages on first boot. When `installQemuGuestAgent` is enabled, a `runcmd:` entry also runs `systemctl enable --now qemu-guest-agent` after package install — the unit's `BindsTo=` the virtio-port device, and the device-binding window passes before cloud-init's package install finishes, so the postinst alone leaves the unit disabled-and-stopped (libvirt then never sees the agent connect, even across in-guest reboots).
- **meta-data** — YAML with instance ID and hostname. The instance ID is **`<vmName>-<sha256(user-data) prefix 12 chars>`**, not just `<vmName>`. cloud-init gates nearly every module (`users`, `set_passwords`, `ssh_authkey_fingerprints`, `runcmd`, `package_update_upgrade_install`, `write_files`, `bootcmd`) on instance ID with frequency `once-per-instance` — a stable instance ID makes every config change a silent no-op on already-booted VMs. Hashing the user-data means an unchanged config preserves the ID (no surprise re-runs), while any edit (password, SSH key, packages, hostname, runcmd) produces a fresh ID and cloud-init re-applies on the next boot. Module re-runs are idempotent for our generated user-data (apt is no-op for already-installed packages, `systemctl enable --now` is idempotent, user creation/password set just rewrites).

### Password hashing

Passwords are hashed using `openssl passwd -6` (SHA-512 crypt) before being written to the user-data YAML. The plaintext password is never stored on disk; the SHA-512 crypt hash is persisted in `cloud-init.json` as **`passwordHash`** so subsequent saves can re-emit the same hash without re-hashing.

**Placeholder semantics.** The API never returns the plaintext or hash; `password` is exposed to clients as `"set"` (or empty). When the UI sends `password` back as `"***"` (or legacy `"set"`), the backend treats it as **"leave password unchanged"** and re-uses the stored `passwordHash`. Re-hashing the literal placeholder string would silently downgrade the VM password — explicitly avoided.

**Dual emission (`users[].passwd` + `chpasswd`).** cloud-init's `cc_users_groups` module only applies `passwd:` on user *creation* — for an existing user it logs "already exists, skipping" and leaves the password untouched, even when a fresh instance-id forces the module to re-run. The user-data therefore also emits a top-level `chpasswd:` block (cc_set_passwords module) which runs `chpasswd -e` against existing accounts unconditionally. The two are complementary: `users[].passwd` covers the first-boot creation path, `chpasswd` covers every subsequent password edit. `expire: false` is set on `chpasswd` so the user isn't prompted to change the password on first login.

### YAML emission

`user-data` and `meta-data` are produced by **js-yaml** (`yaml.dump`), not template literals. Every scalar is automatically quoted/escaped, so user-controlled fields cannot inject sibling YAML keys (e.g. `runcmd:` / `write_files:` / `packages:`). Input fields also have route-level regex constraints as defense in depth:

| Field | Regex / limit |
|-------|---------------|
| `hostname` | `^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$` (RFC 1123 label, ≤ 63 chars) |
| `username` | `^[a-z][a-z0-9_-]{0,31}$` |
| `password` | `^[^\r\n]*$`, ≤ 256 chars (CR/LF rejected) |
| `sshKey` | ≤ 16384 chars; split on newlines into individual key entries |
| `sshKeySource` | `^[a-zA-Z0-9:_-]*$` |

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

The generator unlinks any existing `cloud-init.iso` before invoking `cloud-localds` / `genisoimage`. libvirt's `dynamic_ownership` chowns the file to `libvirt-qemu:kvm` on VM start and only chowns it back on a clean stop, so without the unlink a regenerate after the VM has run (especially after a force-stop or crash) hits `EACCES` trying to truncate a file the wisp user no longer owns. Per-VM directories are `wisp:libvirt 0775`, which grants unlink regardless of file ownership; the freshly created ISO is owned by the wisp user and libvirt re-chowns it on the next start.

## GitHub SSH Key Import

SSH keys can be imported from a GitHub user profile:

1. User enters a GitHub username in the UI
2. Frontend sends `GET /api/github/keys/:username`
3. Backend fetches `https://github.com/<username>.keys` server-side (no direct browser-to-GitHub request — prevents CORS issues and SSRF from the frontend). The fetch sets `redirect: 'manual'` so a hostile/compromised upstream that ever 30x's into a private IP can't turn this auth-required proxy into an SSRF; a 3xx surfaces as **502**.
4. Per-IP rate limit: 10 requests / 60 s (sweep every 60 s, max 10 000 entries). Excess hits return **429**.
5. Returns the list of SSH public keys
6. User confirms which key(s) to use
7. Selected key is written to the `sshKey` field with `sshKeySource: "github:<username>"`

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
