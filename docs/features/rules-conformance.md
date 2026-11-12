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

**Settled after the audit (2026-11-12):** every decision in `AUDIT.md` goes as the audit
recommends, with one exception: TMO-4 (the OS upgrade's 600 s cap) stays as it is, under the
backlog entry "OS upgrade runs inside wisp.service". So, in short:
- CFG-2: an invalid `trustedProxies` entry fails startup. This reverses
  `CONFIGURATION.md`'s "a typo must not crash-loop".
- LAY-3 and LAY-4: a hand-rolled layer stack, and no modal closes on a backdrop click.
  The `[PROJECT]` exception leaves FRONTEND-RULES § Layers.
- FEN-2: the fence lint is `npm run check-fences`, listed in AGENTS.md Project Facts.
- FEN-5: undici is fenced to `lib/downloads/`.
- Docs: TECH-STACK (dbus-next callers) and FRONTEND-RULES ("first field gets
  `autoFocus`") are fixed to match.

## Milestone 2a — config and fences

The §4 and §7 findings.

- **Acceptance:**
  - `npm run check-fences` fails on a deliberate stray import (e.g. `dbus-next` from a
    route), then passes once that import is removed.
  - A config file with an unknown key, a wrong type or invalid JSON fails the dev
    backend's startup with a message naming the key or the parse error.
  - Every value the UI writes (backup schedule, OIDC, advertised URL, trusted proxies)
    passes the startup read: save each one through the UI or API, then restart.
  - Deleting a mount used as a backup destination leaves no dangling reference.
  - A bad `runtime.env` line fails startup.
  - `npm run check-imports` passes.

## Milestone 2b — timeouts

The §6 findings except TMO-4.

- **Acceptance:**
  - Each added timeout or watchdog is shown to fire, pointed at a blackhole address, a
    hung command or a stalled stream (on tini where it needs Linux).
  - A normal long job (a large backup, a convert, an image pull) still completes.

## Milestone 2c — frontend

The Data, Phones and touch, and Layers findings. DAT-9 (cloud-init fetch failure) comes
first.

- **Acceptance:**
  - Each fixed finding is observed in the dev stack or a Vite harness.
  - A modal keeps Tab inside, returns focus to its opener, and leaves the page under it
    inert. Esc closes only the top layer, and a backdrop click closes nothing.
  - On a phone-width emulated touch device, fields don't zoom and nothing is focused by
    code.
  - Row actions are reachable on a touch device at 1024px or wider.
  - The frontend build passes.

Each finding in `AUDIT.md` ends up marked fixed or backlogged.
