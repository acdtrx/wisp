# Phone modal editors for VM/container detail sections

## Goal

Env, Disks, Network interfaces, and Mounts are read-only below `sm`. Move
their add/edit flows to **modal form editors** per `docs/UI-PATTERNS.md`
§ Modal form editor — the pattern Host Mgmt's SMB/drives/bridges already
follow (commit `386e880` is the template) — so the full management surface
works from a phone. UI-PATTERNS already names these inline editors as
refactor candidates; this executes that direction.

## Scope

Modal editors become **the** editor at every breakpoint, not a phone-only
alternate: table rows go read-only, inline cell-swapping editors are deleted,
header Add buttons become visible at all sizes, and wide action sets adopt
the tap-to-expand strip below `sm` (HostStorage reference). Four sections:

1. **Container Env** (`ContainerEnvSection.jsx`) — new `EnvVarEditorModal`
   (key, value, secret toggle, generate-secret). Row save keeps the
   documented whole-`env`-patch exception.
2. **VM Network interfaces** (`VmNetworkInterfacesSection.jsx`) — new
   `NicEditorModal` (bridge select, model control, MAC + randomize +
   cloud-init warning). Save keeps the documented full-`nics`-array PATCH
   exception. `networkLocked` (VM running) keeps gating exactly as today.
3. **Container Mounts** (`ContainerMountsSection.jsx`) — new
   `ContainerMountEditorModal`, one modal with two entry points like
   `RemovableDriveEditorModal`: create (kind passed from the header Add
   tapped: file / folder / tmpfs) or edit (row passed). Row-scoped mount
   APIs unchanged. Edit-file / upload / zip-upload stay row actions (already
   phone-visible); `MountFileEditorModal` untouched.
4. **VM Disks** (`DisksSection.jsx`) — new `DiskEditorModal` replacing the
   two non-create inline mechanisms: edit (sda/sdb size + bus) and
   add-second-disk (create-new or attach-existing + size + bus). CDROM ISO
   attach/eject and disk detach are **actions, not forms**: un-hide them on
   phones; attach keeps opening `ImageLibraryModal` directly.

Docs in the same edits: `docs/spec/UI.md` § Responsive behavior (:103–108
rewritten — detail sections become fully manageable on phones) and the
per-section descriptions; `docs/UI-PATTERNS.md` § Variants + § Reference
implementations rows for the four sections; `docs/BACKLOG.md` entry deleted
when the feature ships; `CHANGELOG.md`.

## Out of scope

- **The `isCreating` paths.** `CreateVMPanel` mounts DisksSection and
  VmNetworkInterfacesSection with draft-row flows; create remains
  desktop-oriented (UI.md:97). The create-path branches must keep working
  untouched — the modal migration applies to the detail-page (non-create)
  paths only.
- Cloud-init phone editing (stays view-only per UI.md:101).
- Any backend/API change — every mutation keeps its existing endpoint and
  payload shape, including the two documented replace-whole exceptions.
- New breakpoint hooks: no JS viewport detection exists and none is added;
  responsive behavior stays pure Tailwind classes.

## Constraints and decisions (settled 2026-08-25)

- One purpose-named modal per entity kind, local form state, delta-patch
  save, `FormModalChrome` primitives, `closeOnBackdrop/Escape={!saving}`,
  sticky `FormModalError`, `await onSaved()` then close — exactly the
  `SmbShareEditorModal` structure.
- **Dialog stacking**: the Env generate-secret `ConfirmDialog` moves inside
  `EnvVarEditorModal` (Dices beside the value field → confirm with one-time
  copyable value → Apply fills the field, modal Save commits). While a
  nested dialog is open the parent modal sets `closeOnEscape={false}` so
  Escape closes only the top layer. Same rule anywhere a confirm opens over
  an editor modal.
- **No nested library picker**: `DiskEditorModal`'s attach-existing selects
  from a fetched list of library images in a plain `select` — it does not
  open `ImageLibraryModal` inside itself. The full picker remains the
  direct-action path for ISO slots.
- Row actions below `sm`: sections whose action set no longer fits keep the
  Actions column `hidden sm:table-cell` and add the tap-to-expand strip
  under the row (HostStorage.jsx reference); a section whose read-only
  action set fits (single icons) may keep the column visible like
  HostNetworkBridges.

## Steps

Branch `feature/phone-modal-editors` in a worktree under
`.claude/worktrees/`; one step per section, smallest first; each step
commits before the next starts.

1. **Container Env** — `EnvVarEditorModal` + section rewrite to read-only
   rows; secret flows absorbed; phone un-hiding.
2. **VM Network interfaces** — `NicEditorModal` + section rewrite;
   `isCreating` branch preserved bit-for-bit.
3. **Container Mounts** — `ContainerMountEditorModal` + section rewrite;
   uploads/edit-file stay row actions; tap-to-expand strip.
4. **VM Disks** — `DiskEditorModal` + section rewrite of the non-create
   mechanisms; ISO/detach actions un-hidden on phones; `isCreating` branch
   preserved.
5. **Docs close-out + release** — UI.md responsive section rewrite,
   UI-PATTERNS variants/reference updates, backlog entry removal, CHANGELOG;
   cut `2.3.0-beta.1`.

Acceptance per step: frontend build passes; the section drives correctly in
a Vite harness (canned fetch/API responses, since workload detail is
unreachable on macOS stubs) at 375 px and desktop widths — create, edit,
validation error, cancel, and delete all exercised; screenshots reviewed;
harness files deleted afterwards. The create-path steps additionally verify
`CreateVMPanel` still renders and drafts correctly (host-level page, real
dev stack).

## Verification

- Per-step harness pass as above; final pass re-drives all four sections.
- Real acceptance: the user drives the `2.3.0-beta.1` beta on an actual
  phone against the Linux server — add/edit/delete in each of the four
  sections without reaching for a desktop.

## Status

Implemented 2026-08-25 (all five steps). Each section verified in a Vite
harness at 375 px and desktop with canned APIs — payload/patch shapes and
call sequences confirmed against the pre-rewrite contracts; the two
`isCreating` draft flows verified unchanged in the real dev stack. Shipping
in `v2.3.0-beta.1`; real-phone acceptance is the user's beta pass.
