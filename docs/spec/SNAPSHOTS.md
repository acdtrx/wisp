# Snapshots

Snapshots capture the state of a VM at a point in time, allowing the user to revert to that state later.

## Requirements

- Snapshots require **qcow2 disk format**. VMs with raw, img, or vmdk disks cannot use snapshots. If the VM's primary disk is not qcow2, the UI displays a notice: "Snapshots require qcow2 disk format."

## Snapshot Data

Each snapshot includes:

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | User-provided snapshot name |
| `creationTime` | number | Unix timestamp of creation |
| `state` | string | VM state at time of snapshot (e.g. "running", "shutoff") |

## Operations

### List

Returns all snapshots for a VM. Each snapshot's metadata (name, creation time, state) is extracted from the snapshot XML.

The backend calls `ListDomainSnapshots` to get snapshot object paths, then `GetXMLDesc` on each to extract metadata.

### Snapshot name validation

Every snapshot operation (create, revert, delete) validates the name against `^[a-zA-Z0-9 ._-]+$` (max 64 characters, no `..` or path separators). Both the JSON-schema check on the create route and the in-library `validateSnapshotName` enforce the same accept set so revert/delete can't be used as a path-traversal primitive against the snapshot memory file location.

### Create

Creates a new snapshot with a user-provided name.

- **Running VM (live snapshot):** Uses external memory to capture running state. The snapshot XML includes disk and memory state. The memory file is `<vmDir>/snapshots/<name>.mem`, where the name is encoded one-to-one so two snapshots never share a file: letters, digits and `-` stay, every other character (space, `.`, `_`) becomes `_` plus its two-digit hex code (`a b` → `a_20b.mem`, `a_b` → `a_5fb.mem`). The full path is stored in the snapshot XML, so existing snapshots keep whatever file they were created with.
  - **Disks move onto external overlays.** The snapshot XML names no `<disks>`, so libvirt snapshots every writable disk externally: it creates an overlay next to each image (`disk0.qcow2` → `disk0.<name>`, backing file the original), and the domain — live and persistent definition — points at the overlay from then on; new writes land there and the original stays frozen at the snapshot point. The domain keeps pointing at the overlay until the snapshot is deleted. Read-only disks (the cloud-init CD-ROM) are not overlaid.
- **Stopped VM (offline snapshot):** Captures disk state only, as an internal snapshot inside each qcow2 file — no new files.

**Backups** of a VM with overlays are flattened: each disk's backup is one standalone qcow2 holding the current (base + overlays) content, under the base's file name; snapshots themselves are not backed up. See [BACKUPS.md → Disks on a backing chain](BACKUPS.md#disks-on-a-backing-chain). A backup cannot be restored **in place** while the VM has any snapshots (409 `VM_HAS_SNAPSHOTS`) — delete them first; see [BACKUPS.md → Restoring in place](BACKUPS.md#restoring-in-place).

Created via `Domain.SnapshotCreateXML(xml, flags)`.

### Revert

Reverts the VM to a previously captured state.

1. Looks up the snapshot by name via `Domain.SnapshotLookupByName`
2. Calls `Revert` on the snapshot object

After revert, the VM is in the same state it was when the snapshot was created (running or stopped).

### Delete

Removes a snapshot.

1. Looks up the snapshot by name
2. Calls `Delete` on the snapshot object

This does not affect the current VM state — it only removes the saved snapshot point.

## UI Presentation

The Snapshots section appears in the VM Overview panel as a section card with a compact table:

| Column | Content |
|--------|---------|
| Name | Snapshot name |
| Created | Human-readable date/time |
| State | VM state at snapshot time |

Row actions: Revert (with confirmation) and Delete (with confirmation).

A "Create Snapshot" button at the top of the section opens a prompt for the snapshot name.

When no snapshots exist, an empty state is shown (e.g. "No snapshots").

When the VM's disk format doesn't support snapshots, a note is displayed instead of the create button.
