# Migrations at start

Phase 7 of `docs/reviews/2026-11-17/IMPLEMENTATION.md`, first feature. Finding P-3 of
that folder's `AUDIT.md`. Built to the plan's ground rule 1: what a build from scratch
would have.

## What it is for

Stored state must be in the current shape whenever Wisp runs (CODING-RULES §16). Today
the state migrations run from the updater and the installer, so every other way of
starting newer code can run on state it does not understand: a manual upgrade, a stop
followed by a start, a dev push, a config restored from an older copy. This feature makes
the backend bring its own state up to date every time it starts, and takes that job away
from everything else.

## Decisions

- **The backend runs the pending migrations at every start**, before it reads stored
  state for any other purpose, starts a workload or answers a request.
- **Nothing else runs them.** Not the updater, not the installer, not the shared setup
  steps, not `wispctl`, and no command runs them on demand. `backend/scripts/migrate.mjs`
  goes, with its `--dry-run` and `--list` modes: what ran is in the ledger and in the
  start's log.
- **A start that cannot migrate does not serve.** A failed migration, or a config that
  is still invalid once they have run, ends the start with a non-zero exit and a log line
  naming the migration and the reason. The next start tries again.
- **A start with nothing pending costs a ledger read**: no extra connection to libvirt or
  containerd.
- **The service says when it is ready, and systemd is the gate** (settled 2026-11-18,
  replacing the 2026-10-16 rejection of `Type=notify`). `wisp.service` is `Type=notify`;
  the backend sends the ready message with systemd's own `systemd-notify` once it
  listens. `systemctl start` then waits through the migrations, returns when Wisp is
  ready and fails when the process exits first. The updater, the installer and a
  rollback use that, with no gate code of ours. The fixed 90 s goes.
- **A start that keeps failing backs off**: retries go from 5 s up to 5 min.
- **Rollback keeps its shape.** The tree and `config/`, ledger included, come back
  together; the old backend then finds nothing pending. What a migration changed outside
  `config/` is not undone, as today.

## What it changes in the docs

- `CODING-RULES.md` §16, the "Applied" line: at every start of the backend, not during
  the update (settled 2026-11-18, replacing 2026-10-16).
- `ARCHITECTURE.md`, State and the start-up order.
- `PRODUCTION.md`, Deploys: the updater's step list.
- `specs/UPDATES.md`: the updater and shared-steps rows, Health-gated start, Rollback,
  and State migrations (when they run, the runner, failure).
- `specs/DEPLOYMENT.md`: the manual upgrade paths say nothing about migrations, because
  they need nothing.
- `BACKLOG.md`: "No check sees the manager members a migration reads" stays; nothing
  else is touched.

## Constraints

- One runner, inside the backend. Its pure parts (which migrations are pending, the
  ledger's read and write, the file-name and id rules) get unit tests in the harness.
- Migrations keep their contract: an id, a description, `run(ctx)`, safe to run again.
  With no dry run, `ctx.dryRun` and each migration's guards for it go.
- The first release that carries this is installed by the previous updater, with its
  90 s gate. The builder says what that means for that one update before building.
- Linux paths are verified in a throwaway VM, never against the test host's own ledger
  or settings.

## Milestones

### 1. The backend migrates when it starts

Acceptance, in a throwaway VM with Wisp installed from the branch:

- With one migration's ledger entry removed, `systemctl restart wisp` runs it before the
  backend listens: the log shows the migration, then the listening line; the ledger
  holds the entry again; the API answers.
- The same with `systemctl stop wisp` then `systemctl start wisp`.
- With nothing pending, a start logs that nothing is pending and opens no extra
  connection to libvirt or containerd.
- With a migration made to throw, the backend exits non-zero, the log names the
  migration and its error, and the port is never opened. With the file restored, the
  next start runs it and serves.
- With `wisp-config.json` made invalid, the start ends with the config error, as today.
- On the Mac dev stack a start runs the migrations against the stubs and serves.
- `npm run check` passes, with the runner's new unit tests in it.

### 2. Nothing else runs them

- The updater, the installer, the shared setup steps and `wispctl` hold no migration
  step. `migrate.mjs` and `ctx.dryRun` are gone.
- The updater's health gate follows the decisions above.
- The docs listed above.

Acceptance, in a throwaway VM:

- No file outside `backend/src` names the migration runner; `npm run check` fails if one
  does.
- An update to a build with one migration pending completes: the migration ran in the
  new backend's start, and the gate passed after it.
- An update to a build whose migration throws rolls back within seconds of the failed
  start, not at the ceiling: tree, config and ledger are the old ones and the old
  backend is healthy.
- An update to a build whose migration takes two minutes completes.
- After replacing the tree by hand (`push.sh`) with one migration pending, a restart
  applies it.

## Not in this feature

- The setup path, the bridge and the installer: the next feature.
- A check of the manager members a migration reads: backlog.
