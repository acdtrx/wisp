# API — Sections and home page

The sidebar sections and the home page launcher. Shared contracts (access levels, errors, command responses, jobs, the events stream): [API.md](API.md).

## Sections

User-defined groupings for the sidebar workload list. The synthetic **Main** section (`id: "main"`, `builtin: true`) is always present in responses but never persisted. Workloads with no explicit assignment — or with an assignment pointing at a deleted section — fall back to Main on the next read.

`GET /api/sections` returns the `{ sections, assignments }` envelope; every write answers with an ack ([Command responses](API.md)): `201 { id }` for a create, `204` otherwise. The `sections` topic of `GET /api/events` pushes the envelope to every connected client after each write, the one that sent it included.

### Response envelope

```json
{
  "sections": [
    { "id": "main", "name": "Main", "order": -Infinity, "builtin": true },
    { "id": "9c12…", "name": "Web", "order": 0, "builtin": false }
  ],
  "assignments": {
    "vm:web1": "9c12…",
    "container:nginx": "9c12…"
  }
}
```

`assignments` keys are `"<type>:<workload-name>"` (`<type>` is `vm` or `container`); values are section ids. Missing keys mean Main.

### GET /api/sections · `read`

Return the current sections + assignments envelope.

- **200:** Envelope above.

### `sections` topic (live channel)

The envelope is pushed on the `sections` topic of `GET /api/events`: a full snapshot on connect, then again after every successful section or assignment write (create, rename, delete, reorder, assign, and the assignment move that rides a container rename). A rejected write pushes nothing. No polling timer.

This is the sidebar's live channel for grouping. It exists because sections are pure Wisp metadata — no libvirt or containerd event announces them — so without it a client that never reloads keeps the ordering it saw at mount: an iOS home-screen app resumed from the app switcher, or a desktop tab left open while another device reorders.

- **Topic `data`:** The envelope above, or `{ error, detail }` if the settings read fails. Clients keep their last good envelope on an error frame.
- `Main`'s `order` is `-Infinity`, which serialises to `null` in both the topic frames and `GET /api/sections`. Clients must take array order as authoritative, not the `order` field.

### POST /api/sections · `admin`

Create a section.

- **Body:** `{ "name": "string (1–64)" }`
- **201:** `{ id }` — the new section's id; the section arrives on the `sections` topic.
- **400 (`VALIDATION_FAILED`):** An empty or too-long name, or an unknown key (the body's schema). **422 (`SECTION_INVALID`):** A name of whitespace only.
- **409 (`SECTION_DUPLICATE`):** Case-insensitive name collision.

### PATCH /api/sections/:id · `admin`

Rename a section. The `main` section cannot be renamed.

- **Body:** `{ "name": "string (1–64)" }`
- **204:** Renamed.
- **404 (`SECTION_NOT_FOUND`):** No section with that id.
- **400 (`VALIDATION_FAILED`):** An empty or too-long name, or an unknown key. **422 (`SECTION_INVALID`):** A name of whitespace only, or an attempted Main rename.
- **409 (`SECTION_DUPLICATE`):** Case-insensitive name collision.

### DELETE /api/sections/:id · `admin`

Delete a section. Workloads previously assigned to it return to Main on next read. The `main` section cannot be deleted.

- **204:** Deleted; the next envelope's assignments map no longer references the deleted id.
- **404 (`SECTION_NOT_FOUND`):** No section with that id.

### POST /api/sections/reorder · `admin`

Replace the persisted ordering of user-defined sections. The body must list every existing section id exactly once (Main is implicit and never appears in the array).

- **Body:** `{ "ids": ["<section-id>", "<section-id>", …] }`
- **204:** Reordered; the next envelope has `order` reassigned to the array index.
- **400 (`VALIDATION_FAILED`):** `ids` is not an array of strings. **422 (`SECTION_INVALID`):** `ids` doesn't list every section exactly once.
- **404 (`SECTION_NOT_FOUND`):** An id in `ids` doesn't match any section.

### PUT /api/sections/assign · `admin`

Move a workload to a section.

- **Body:** `{ "type": "vm" | "container", "name": "string", "sectionId": "string | null" }`
- `sectionId === null` (or `"main"`) drops the explicit assignment — the workload returns to Main.
- **204:** Assigned.
- **404 (`SECTION_NOT_FOUND`):** Target sectionId doesn't exist.
- **400 (`VALIDATION_FAILED`):** A `type` other than `vm` / `container`, an empty or too-long `name`, or an unknown key. **422 (`SECTION_INVALID`):** A `name` of whitespace only.

The workload itself isn't validated — assignments are pure metadata, so referencing an unknown VM/container name is a no-op (the entry is ignored on the next list read).

> Section info is **not** embedded in the VM/container list payloads or their live topics. libvirt/containerd don't emit events on assignment changes, so the lists wouldn't be a reliable carrier — the feed could stay stale until the next workload event. Sections get their own topic instead: subscribe to `sections` on `GET /api/events` for steady state. `GET /api/sections` remains for API clients.

---

## Home page

The Home tab's launcher tiles. Everything a tile *is* — its URL, the workload behind it, its live state — is **derived on every read** from workload data (see [UI.md § Tab: Home](UI.md#tab-home) for the derivation rules); only the human overlay (groups, per-tile overrides, manual links) is persisted, under the `homepage` key in `wisp-config.json` (see [CONFIGURATION.md](CONFIGURATION.md)).

Tiles and the MCP `get_deployment_overview` tool read workloads through one aggregate join, `lib/deploymentOverview.js` (`gatherDeployment`), so the two cannot drift. Keep that join the only one.

`GET /api/homepage` returns the `{ tiles, groups }` envelope the `home` topic pushes; every write answers with an ack ([Command responses](API.md)): `201 { id }` for a create, `204` otherwise, and the new envelope reaches every client on the `home` topic. Writes go through these routes only, never `PATCH /api/settings`.

### Response envelope

```json
{
  "tiles": [
    {
      "id": "https://jelly.example.com",
      "kind": "derived",
      "source": "app",
      "name": "Jellyfin",
      "url": "https://jelly.example.com",
      "host": "jelly.example.com",
      "iconId": "jellyfin",
      "hidden": false,
      "workload": { "type": "container", "name": "jelly", "state": "running", "updateAvailable": false },
      "conflicts": []
    },
    {
      "id": "6f2c…",
      "kind": "manual",
      "source": "manual",
      "name": "Router",
      "url": "https://192.168.1.1",
      "host": "192.168.1.1",
      "iconId": "router",
      "hidden": false,
      "workload": null,
      "conflicts": [{ "source": "manual", "publisher": "old link", "manualTileId": "9a01…" }]
    }
  ],
  "groups": [
    { "id": "c81f…", "name": "Every day", "builtin": false, "tileIds": ["https://jelly.example.com"] },
    { "id": "ungrouped", "name": "Ungrouped", "builtin": true, "tileIds": ["6f2c…"] }
  ]
}
```

- **`id`** — a derived tile's id **is its canonical URL** (lowercased host, default port and bare trailing slash dropped); a manual tile's id is its own UUID. Accepted wart: renaming a Caddy subdomain mints a new id, so that tile's overrides and group placement reset.
- **`kind`** is `derived` | `manual`; **`source`** is `app` | `mdns` | `manual`.
- **`workload`** is `null` for external and manual tiles — those are stateless. `state` mirrors the workload's list state (`running`, `stopped`, …).
- **`hidden`** tiles are still sent, so edit mode can unhide them; clients hide them outside edit mode.
- **`conflicts`** lists losers of a same-URL collision. `manualTileId` is non-null when the loser was a manual link, so the UI can offer to remove it.
- **`groups`** is in render order. The synthetic **`ungrouped`** group (`builtin: true`) is always present and always last; it holds every tile no group claims, which is where newly derived links appear. It is never persisted.

### GET /api/homepage · `read`

Return the current envelope.

- **200:** Envelope above.

### POST /api/homepage/groups · `admin`

Create a group.

- **Body:** `{ "name": "string (1–64)" }`
- **201:** `{ id }` — the new group's id. **400 (`VALIDATION_FAILED`):** an empty or too-long name, or an unknown key. **422 (`HOME_INVALID`):** a name of whitespace only. **409 (`HOME_DUPLICATE`):** case-insensitive name collision.

### PATCH /api/homepage/groups/:id · `admin`

Rename a group. Same body and errors as create, plus **404 (`HOME_NOT_FOUND`)**.

- **204:** Renamed.

### DELETE /api/homepage/groups/:id · `admin`

Delete a group. Its tiles fall back to Ungrouped on the next derivation.

- **204:** Deleted. **404 (`HOME_NOT_FOUND`).**

### POST /api/homepage/groups/reorder · `admin`

Replace the group ordering. The body must list every existing group id exactly once (Ungrouped is implicit and never appears).

- **Body:** `{ "ids": ["<group-id>", …] }`
- **204:** Reordered. **400 (`VALIDATION_FAILED`):** `ids` is not an array of strings. **422 (`HOME_INVALID`):** `ids` doesn't list every group exactly once. **404 (`HOME_NOT_FOUND`).**

### PUT /api/homepage/tiles/assign · `admin`

Place a tile in a group, optionally at an index. Moving a tile within its current group at a new index is how **reordering** works — there is no separate endpoint. Tile ids travel in the body because a derived id is a URL.

- **Body:** `{ "tileId": "string", "groupId": "string | null", "index": "integer | null" }`
- `groupId` of `null` (or `"ungrouped"`) drops the placement — the tile returns to Ungrouped. `index` omitted appends.
- **204:** Placed. **404 (`HOME_NOT_FOUND`):** unknown `groupId`. **400 (`VALIDATION_FAILED`):** a missing or empty `tileId`, a negative or non-integer `index`, or an unknown key.
- The tile itself is not validated — placements are pure metadata, and an id that no longer derives is ignored on the next read.

### PUT /api/homepage/tiles/override · `admin`

Set or clear a tile's overrides. An omitted field is left untouched; `null` clears one. An override left empty is deleted outright, so the config never accumulates husks.

- **Body:** `{ "tileId": "string", "hidden": "boolean | null", "name": "string | null", "iconId": "string | null" }`
- **204:** Saved. **400 (`VALIDATION_FAILED`):** a missing `tileId`, a value of the wrong type, a name over 64 characters, or an unknown key. **422 (`HOME_INVALID`):** a name of whitespace only.

### POST /api/homepage/manual-tiles · `admin`

Add a manual link.

- **Body:** `{ "name": "string (1–64)", "url": "string", "iconId": "string | null" }`
- `url` must be an absolute `http`/`https` URL — anything else (a bare hostname, `javascript:`, `data:`) is rejected at the boundary, since tiles render as links the user clicks.
- **201:** `{ id }` — the new link's id. **400 (`VALIDATION_FAILED`):** a missing, empty or too-long field, or an unknown key. **422 (`HOME_INVALID`):** a name of whitespace only, or a `url` that is not an absolute `http`/`https` URL.

### PATCH /api/homepage/manual-tiles/:id · `admin`

Update a manual link (any subset of `name` / `url` / `iconId`).

- **204:** Saved. **404 (`HOME_NOT_FOUND`)**; **400** / **422** as for the create.

### DELETE /api/homepage/manual-tiles/:id · `admin`

Remove a manual link along with its group placement and overrides.

- **204:** Removed. **404 (`HOME_NOT_FOUND`).**

### `home` topic (live channel)

The envelope is pushed on the `home` topic of `GET /api/events`: a snapshot on connect, then again on every VM list change, container list change, and homepage write. No polling timer — every input to the derivation already has a change event. A failed build sends `{ error, detail }` and clients keep their last good envelope.
