# Frontend data flow: one way to read, edit, command and follow

Phase 4 of `docs/reviews/2026-11-17/IMPLEMENTATION.md` (findings D-1, D-2, D-3, D-5, D-6,
D-7, D-9 of that audit). Counts below were taken on `main` on 2026-11-20, after phase 3.

## What it is for

The client does five things with server state: mirror a stream, read a record, edit a
record behind Save, run a command, follow a job. Each exists today in several hand-written
variants, so a new screen copies whichever is nearest and the copies drift:

- **Reading a record**: 24 hand-written reads in 22 component files and 4 more in
  stores, with four different guards against a stale answer (11 sites have none). The same record is read
  by up to four components, each on its own (host bridges ×4, host info ×4, mount status
  ×2, GPUs ×2, settings three ways). No read can be aborted. No read knows "gone" from
  "failed", so a workload deleted elsewhere leaves a spinner for ever.
- **Editing behind Save**: 10 sections, 4 settings forms and 8 modal editors keep
  `form` / `original` by hand, resetting by a hand-kept field list (5), by a signature
  (4) or never (1), each with its own dirty test.
- **Running a command**: about 40 hand-written `saving` / `deleting` / `creating` flags,
  beside one hook with 3 users and the two stores' action maps.
- **Following a job**: three ways left, and 4 hand refetches after a job the stream
  already reports.
- **Mirroring a stream**: 10 stores with three lifecycle naming conventions; a stream
  error is recorded in six and dropped in two. `vmStore` and `containerStore` are about
  250 parallel lines that have drifted in seven places.
- **Names on the wire**: 9 topics and 10 change kinds are bare strings on both sides;
  the client's job-kind table holds 4 of the server's 29 and nothing checks it.
- **Errors**: 33 inline error surfaces cannot be dismissed, and many clear themselves.

This feature gives each of the five one home, converts every caller, and deletes the
variants.

## Decisions

### Names

- **One module holds the wire's names** (topics, change kinds, job kinds) and both the
  backend and the frontend import it. It lives in a new top-level `shared/` folder, which
  holds nothing but names both sides must agree on. A check fails a topic, change kind or
  job kind written as a bare string anywhere else. The release tarball carries the
  folder.

### Mirroring a stream

- **Every store that mirrors a topic or a scoped stream is made by one helper**: the same lifecycle names
  (`connect` / `disconnect`), the handle kept in the same place, a stream error recorded
  the same way in every store, a stream refusal handled the same way.
- **The VM and container stores are one base with a spec each.** The spec holds what
  really differs (the seed fields, which commands are jobs and which end at the ack or
  at a frame, the scheduled-restart and image-update fields, the stats interval).
  Everything else is written once. The seven drifts are settled one way; the builder
  lists each with the side it kept and why.
- **`createSSE` and `createJobSSE` become one stream client**, with "ends at a terminal
  frame" as an option.

### Reading a record

- **One hook, `useRecord(kind, id)`, and one table of record kinds.** The table says,
  once per kind, how the record is fetched and which cue it follows (a `changes` kind, or
  a topic). The hook answers `{ data, status, error, reload }`, with `status` one of
  loading, ready, error, gone.
- **A record is read while something shows it, and once for everyone showing it.** It is
  read again on its cue and when the event stream reconnects. The read is aborted when
  nothing shows it any more: every read wrapper in `api/` takes a `signal`.
- **One guard, in one place**: a view never shows an older answer after a newer one, and
  a failed read that a newer read has replaced shows nothing.
- **A 404 is "gone", not an error.** A page whose workload no longer exists says so
  ("No VM named `x`") with a way back to the list, whether it was deleted elsewhere or
  the URL never named one. It never spins and never jumps away on its own.
- **The stores' own copies go**: the selected VM's and container's record, settings, and
  `hostStore` are records like any other. Direct `getSettings()` calls and the
  "load settings if empty" effects go with them.
- **Pickers follow their record**: the bridge pickers follow `network-bridges`.

### Editing behind Save

- **One form hook** for every form that stages edits behind a Save or a confirm: the 10
  sections, the 4 settings forms, the 8 modal editors. It takes the saved record and one
  pure function from record to form values, and answers the form, a setter, `dirty` and
  a reset.
- **A form follows its record by value**: when the saved values this form shows change,
  the form is reset to them; a write elsewhere in the record does not touch it. This is
  today's behaviour, minus the hand-kept field lists.
- **`dirty` is computed one way**, by value against the saved form.
- **ESLint's hook-dependency rule is switched on as an error.** Inline disables stay
  impossible, so every effect in the frontend states its dependencies honestly.

### Running a command

- **A command's busy flag and its error are held one way.** A workload's actions live in
  the workload store, because the list shows them too. Every other command uses one hook
  that runs it, stays busy as FRONTEND-RULES Data says (until the stream brings the new
  state, or the ack for the kinds that end there), and holds its error.
- **A job-based command stays busy until the job ends and the re-read has landed.**

### Following a job

- **Two calls, each with one use**: `awaitJob(jobId)` to act on a job's end, and one
  hook to show a job's progress from the tray's row. Nothing else reads a tray row, and
  nothing refetches by hand after a job: the list or the record arrives by the stream.

### Errors

- **One error display**, the `ErrorBanner` that phase 6 had listed, built here instead:
  `SectionCard`, the modal chrome and the six hand-made banners all use it, and it can
  always be dismissed.
- **How long an error stays** (proposed wording for FRONTEND-RULES, Errors):
  - a command's error stays until the user dismisses it or runs that command again;
  - a failed read is the view's error state: it stays until a read succeeds or the user
    dismisses it, and it never hides data that was already shown.
- **Every view that reads has a loading, an empty and an error state**: the ones missing
  today (API tokens, host storage status, update status, the create panel's bridge list)
  get them from the hook.

### Clean-up

- Exports nothing imports are removed, and a check fails a new one.

## Behaviour changes

Everything else behaves as today.

- A page for a workload that is gone says so, instead of spinning or deselecting.
- An inline error can be dismissed, and does not vanish on its own except as above.
- Bridge pickers show a bridge created or deleted elsewhere without a reload.
- The VM General section waits for the VM's record like every other section, instead of
  first rendering the list's summary.
- After a rename the page follows to the new name only if the user is still on it (VMs
  and containers).
- A host command that runs as a job stays busy until its result is on screen.
- The two workload stores' drifts, each settled one way (reported by the builder before
  it builds them).

## What it changes in the docs

- `FRONTEND-RULES.md`, Data: the applied line "one Zustand store per subsystem,
  mirroring the established `vmStore` patterns; `createSSE` / `createJobSSE`" is replaced
  by the five homes above. Errors: the two lifetimes. React: the dependency rule is
  linted.
- `ARCHITECTURE.md`: The client (how server state reaches a view: a topic store, a
  record, a scoped stream); Repo layout (`shared/`).
- `specs/UI.md`: View Switching (the gone page); the loading, empty and error states.
- `specs/ERROR-HANDLING.md`, Stale responses: the one guard.
- `TECH-STACK.md` Testing & lint and the commands line in `AGENTS.md`: the new checks.
- `reviews/2026-11-17/IMPLEMENTATION.md`: `ErrorBanner` moves from phase 6 to here.
- `BACKLOG.md`, removed where this closes them: "A VM deleted elsewhere leaves its open
  tab on an endless spinner", "The VM General section renders the list seed", "A VM
  rename navigates even after the user moved on", "Job-based host commands go idle
  before the re-read". The builder names any other entry the shared code closes.

## Constraints

- No new dependency.
- Nothing changes on the wire: no route, body or topic.
- The unit tests from phase 1 that pin the stores, the stream client and the job tray
  keep passing, except where a listed behaviour change replaces what they pinned.
- Pure code (the record guard, the store base, the form hook's value logic, the stream
  client) gets unit tests. Screens are checked by running them: the Vite harness in
  light, dark and phone widths, and the test host for real workloads.

## Milestones

### 1. Names and streams

- The shared names module exists and both sides import it. The check finds no topic,
  change kind or job kind as a bare string outside it, and fails on one added by hand.
- One stream client: `createJobSSE` is gone, its tests carried over.
- Every stream store comes from the one helper: the count of `start*SSE` / `stop*SSE` /
  `startSettingsSync` names is zero, and a stream error frame shows in the sections
  list and the job tray as it does elsewhere.
- VM and container stores are made by one base. Both stores' unit tests pass against it.
- On the test host, a build made by the release path starts and serves (the tarball
  carries `shared/`), and the VM list, container list, stats, home, sections, discovery,
  backups and job tray all update live.

### 2. Records

- `useRecord` and the record table exist, with unit tests for the guard, the shared
  read, the abort and "gone".
- The count of hand-written record reads is zero: the 24 component sites, the selected
  workload in both stores, settings, `hostStore`. Every read wrapper takes a `signal`.
- With the VM page open, deleting that VM from another tab shows the gone page; so does
  opening `/vm/<no such name>`. The same for a container.
- Two components showing the same record cause one request (seen in the browser's
  network panel: the Host page's storage and a container's mounts).
- Creating a bridge on the Host page adds it to an open NIC picker without a reload.
- Leaving a page while its read is in flight cancels the request (network panel).
- Each view that reads shows its loading, empty and error state (error: the backend
  stopped, in the Vite harness).

### 3. Commands, jobs and errors

- The count of hand-written busy flags for commands is zero outside the command hook and
  the workload stores.
- The count of tray-row reads outside the progress hook, and of hand refetches after a
  job, is zero.
- A host mount, a bridge create and an image download each keep their control busy until
  the new state is on screen.
- Every inline error has a dismiss, stays through a re-read of other data, and is
  replaced when its command is run again. The count of error markup outside
  `ErrorBanner` is zero.

### 4. Forms and the dependency rule

- The count of hand-written `form` / `original` blocks is zero: 10 sections, 4 settings
  forms, 8 modal editors use the form hook.
- With a VM's General section open and unsaved in one tab, saving its Advanced section
  from another tab leaves the General form as typed; saving General from the other tab
  resets it.
- `react-hooks/exhaustive-deps` is an error in `eslint.config.mjs` and `npm run check`
  passes.
- The unused-export check passes and fails on an export added by hand.
- The backlog entries above are gone, each observed fixed.

## Not in this feature

- Splitting sections into a create and a detail component, the other primitives
  (Button, IconButton, Badge, Tabs, Field), `ImageLibrary.jsx`'s rewrite: phase 6.
- What needs the server to change: a busy wait ending on a frame it did not cause, a
  save that only normalises, a late USB unplug, a stale `vms` frame undoing a rename.
  They stay in the backlog.
- The self-update's wait for the backend to come back, and its poll.
