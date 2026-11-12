# Rules conformance

**For:** checking the code against the rules adopted with the 2026-11-12 template sync,
which were adopted without such a check. Closes the backlog entry "Check the code against
the rules adopted with the template sync (2026-11-12)".

**Rules checked:**
- CODING-RULES §4: config is read strictly — unknown keys and wrong types fail at
  startup (e.g. an invalid persisted `backupSchedule` currently falls back to defaults on
  read).
- CODING-RULES §6: every outbound request and subprocess has a timeout.
- CODING-RULES §7: a lint enforces the external-system import fences
  (`npm run check-imports` checks only that imports resolve).
- FRONTEND-RULES Data: growing collections are bounded; loading, empty and error states
  are present.
- FRONTEND-RULES Phones and touch: 16px fields, no programmatic focus on touch, hover
  only under `@media (hover: hover)`.
- FRONTEND-RULES Layers: the page under a modal is inert, Tab stays inside the modal,
  focus is returned on close; Wisp's modals still close on a backdrop click.

**Specs changed:** `specs/CONFIGURATION.md` if strict reading changes what an invalid
config does at boot; AGENTS.md Project Facts if the fence lint adds a command.

## Milestone 1 — audit

Write `docs/reviews/2026-11-12/AUDIT.md`: every violation of the rules above, with file,
line and a fix sketch, grouped by rule. Mark each finding **clear** (the rule settles the
fix) or **decision** (it needs the user's call — e.g. dropping backdrop-click close,
whether a bad stored config should stop the backend from booting). Report to the design
session.

- **Acceptance:** the audit exists. Each rule above has a section with its findings or
  "none found", and each finding is marked clear or decision.

## Milestone 2 — fixes

Fix the clear findings and the decision findings the user settles. Backlog the rest.

- **Acceptance:**
  - The fence lint runs as an npm script and fails on a deliberate stray import (e.g.
    `dbus-next` from a route), then passes once that import is removed.
  - A config file with an unknown key or a wrong type fails the dev backend's startup
    with a message naming the key.
  - Each fixed frontend finding is observed in the dev stack or a Vite harness. A modal
    keeps Tab inside, returns focus to its opener, and the page under it doesn't scroll
    or take clicks. On a phone-width emulated touch device, fields don't zoom on focus.
  - Each added timeout is shown to fire (pointed at a blackhole address or a hung
    command).
  - The frontend build passes, and `npm run check-imports` passes.
  - Each finding in `AUDIT.md` is marked fixed or backlogged.
