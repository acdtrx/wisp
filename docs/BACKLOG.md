# Backlog

Pending small items, one entry each. Items that outgrow their entry graduate
to a plan in `docs/plans/` (see `CLAUDE.md` § Plans).

- **Sidebar: manual within-section workload ordering** — a third sort mode
  alongside alphabetical and online-first; the order lives on the section
  assignments so it is the single ordering shared by every consumer. Revisit
  when: the existing sorts demonstrably fight a real workflow — repeatedly
  hunting for a workload the sort keeps burying.
- **Create VM: NIC draft sync warns during render** — `syncNicsToParent` calls
  `onFormChange` from inside a `setNics` updater, so React logs "Cannot update
  a component (`CreateVMPanel`) while rendering a different component"; the
  sync belongs in an effect or plain handler. Predates the modal-editor
  refactor (reproduced on the pre-refactor file, 2026-08-25). Revisit when:
  touching the VM create form's draft wiring, or if the warning graduates to
  an actual state bug.
