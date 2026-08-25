# Backlog

Pending small items, one entry each. Items that outgrow their entry graduate
to a plan in `docs/plans/` (see `CLAUDE.md` § Plans).

- **Sidebar: manual within-section workload ordering** — a third sort mode
  alongside alphabetical and online-first; the order lives on the section
  assignments so it is the single ordering shared by every consumer. Revisit
  when: the existing sorts demonstrably fight a real workflow — repeatedly
  hunting for a workload the sort keeps burying.
- **Idea: dark mode** — the "Dusk" direction from the Home page design
  exploration (deep spruce-dusk palette, glowing running workloads) is the
  reference for what Wisp's dark theme should feel like. Revisit when: regular
  use in dark surroundings makes the light-only UI an observed irritation —
  not on aesthetic impulse.
- **Phones: modal form editors for VM/container detail sections** — Env,
  Disks, Network interfaces, and Mounts are read-only below `sm`; move their
  add/edit to modal form editors the way Host Mgmt's SMB/drives/bridges
  already work (referenced from `docs/spec/UI.md` § Responsive Behavior).
  Revisit when: a real phone session needs to add or edit one of these
  sections and the read-only fallback forces a trip to a desktop.
- **Create VM: NIC draft sync warns during render** — `syncNicsToParent` calls
  `onFormChange` from inside a `setNics` updater, so React logs "Cannot update
  a component (`CreateVMPanel`) while rendering a different component"; the
  sync belongs in an effect or plain handler. Predates the modal-editor
  refactor (reproduced on the pre-refactor file, 2026-08-25). Revisit when:
  touching the VM create form's draft wiring, or if the warning graduates to
  an actual state bug.
