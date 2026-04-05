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

### Create

Creates a new snapshot with a user-provided name.

- **Running VM (live snapshot):** Uses external memory to capture running state. The snapshot XML includes disk and memory state.
- **Stopped VM (offline snapshot):** Captures disk state only.

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
