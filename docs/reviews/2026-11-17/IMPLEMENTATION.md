# Simplify and harden — plan for the 2026-11-17 audit

Follow-up to `AUDIT.md` in this folder. Finding IDs (X-1, R-3, …) point there: each has
its files, lines and fix sketch, which this plan does not repeat. "Backlog:" names the
`docs/BACKLOG.md` entries a phase resolves.

Order: the safety net first, because every later phase leans on it; then known defects;
then start-up, install and update (phase 7, moved up on 2026-11-18); then the areas the
audit graded "strained", worst first; then the "workable" ones; docs last, because they
should describe the result. Phases keep their numbers: 1, 2, 7, 3, 4, 5, 6, 8.

## Ground rules, every phase

The audit's main finding is that each campaign added a better pattern beside the old one.
These rules are what stops this plan from doing the same.

1. **Build what a build from scratch would have** (settled 2026-11-18). For each finding
   the target is the design the rule docs would give a new project, not the smallest edit
   to today's code. A phase lands that design whole, or leaves the finding whole to the
   phase that owns it: no patch in between. The standing aims:
   - one way to do each thing, across the app;
   - an install that ends with Wisp usable;
   - stored state that is right whenever Wisp starts, however it was started;
   - the system's own tool before a unit, command or helper of ours.
2. **Convert every caller and delete the old variant.** A phase is done when the count of
   the old shape is zero, and that count is one of its acceptance criteria.
3. **A check holds the line.** Where a script can check the rule, the check lands in the
   same phase and runs with the other lints and in CI, so the old shape cannot come back.
4. **Same behaviour unless listed.** Each phase lists its behaviour changes. A defect met
   on the way that is not listed goes to the backlog.
5. **Verified by running.** Platform paths on the Linux test host, milestone by milestone
   (CODING-RULES §14); pure code by the unit harness from phase 1; UI through the Vite
   harness in light, dark and phone widths.
6. **One feature doc per phase**, written when the phase starts so its file and line
   references are current, agreed with the user before the build, removed when the phase
   is reviewed. Backlog entries leave in the change that resolves them.

## How it is run

- This session is the design session and stays on `main`.
- Per phase: write the feature, agree it with the user, tag `anchor/<topic>`, start one
  builder (Opus 5.5, high effort) in a worktree under `.claude/worktrees/`.
- The builder sends its open points back first. The design session settles them by
  ground rule 1 and says what it settled. The user is asked only where clean designs
  really differ, or where the answer reverses something already settled.
- After each milestone a fresh reviewer (Opus 5.5, high effort) gets the change, the
  feature and the rules, not the builder's reasoning. Findings go back to the same
  builder: fixed or put in the backlog.
- When the last milestone is reviewed and its criteria were observed: rebase, ff merge to
  local `main`, remove the feature doc. Nothing is pushed unless asked; no release is
  cut.
- One phase at a time.

## Decisions (settled 2026-11-18)

- The plan and its order: approved.
- Undefined names and hook rules are checked by ESLint, as a dev-only dependency with
  correctness rules and no style rules. A hand-written scan was rejected: finding an
  undefined name needs scope analysis.
- A unit harness on `node --test`, for code with no platform behind it only. Manager
  paths stay verified by running them (CODING-RULES §14).
- Phase 3 changes the wire, all four: the error body, one job progress route, `POST` for
  the package refresh, unknown body keys refused.
- The Linux test host is used for the whole plan: deploys of a phase's branch, throwaway
  VMs and containers, and a throwaway VM to run the installer in. Existing workloads and
  settings stay untouched.
- Clean design before smallest change: ground rule 1. It was added after phase 2's
  install and upgrade fixes had been framed as patches (a restart that also migrates, a
  command to finish networking). Those two findings, P-1 and P-3, moved to phase 7.
- State migrations run when the backend starts, every time, before it serves; not from
  the updater, the installer or a command. This replaces "during the update, with the
  backend stopped" (settled 2026-10-16): a start that did not come through the updater
  must not meet unmigrated state either.
- The bridge is part of setup, not an optional extra: without it no VM or container has
  a network. It is set up through the host's own network tool, with no unit or command
  of ours to finish the job.
- No database: the SQLite idea was looked at and dropped.

## Phases

### 1. Safety net — S–M

Done 2026-11-18, merged to `main` from `anchor/safety-net`. Beyond the list below it added
a check of every named import between backend files, and broke a fourth cycle, in
`downloads/`. The release workflow's gate is first observed at the next release.

Why first: there is no test or lint to say a conversion broke something, and a broken
updater would ship unnoticed.

- One command, `npm run check`, runs every check below; builders and CI both use it.
- CI gate in `release.yml` before anything is published: `bash -n` on every script,
  `npm run check`, the frontend build (P-2).
- Undefined names and hook misuse fail the check (X-6). The five stale `eslint-disable`
  comments go. The hook-dependency rule is switched on in phase 4, where the hooks that
  own the dependency arrays land.
- Facade parity: every facade export exists in `linux/` and `darwin/` (X-4).
- Cycle check (X-5). The two simple cycles are broken here; the three in containerManager
  are listed as named exceptions, and phase 5 empties the list.
- A unit harness for pure timing and state code: `fe/api/events.js`, `fe/api/sse.js`,
  `vmStore`, `containerStore`. The first tests pin today's behaviour, which phases 3 and
  4 must keep.
- Docs: TECH-STACK "Testing & lint", CODING-RULES §14, the commands line in AGENTS.
- Backlog: "The backend's import graph isn't checked for cycles", "Nothing catches a use
  of an undefined name".

### 2. Known defects — M in total, each S

Why second: cheap, and they are stability problems today.

- Fix: fresh install without a bridge ends with no networking (P-1); manual upgrade paths
  skip migrations (P-3); noVNC pinned (P-5); image-update job missing from the tray
  (R-7); an unreachable containerd read as "name is free" or "image not local" (C-2); a
  failed Eject shows nothing (D-8).
- Confirm on the test host, then fix or dismiss: firmware read-back and the orphaned
  `VARS.fd` (V-4); a dead CIFS share freezing the backend (V-6); mDNS after a dropped
  system bus (V-10); same-named VM and container marking each other busy (D-4);
  `mountName` containing `%` (R-10).
- Backlog: "Host power and the SMB mount toggle swallow errors", "Settings forms drop bad
  paths on the client", "Container task-delete errors are swallowed", "A failed SMB
  connection test leaves its directory" (two entries, one defect).
- P-1 is checked by running the installer in a throwaway VM on the test host.
- Behaviour changes: a create, rename or restore answers an error when containerd cannot
  be reached; a fresh install sets up the bridge and CNI.

### 3. HTTP boundary: jobs, errors, schemas — L

Why here: routes and jobs are the two backend areas graded "strained", and this is where
a new command has six steps that fail silently when missed (R-9). About the size of
command acks.

- **Jobs, one mechanism.** One store, one way to start a job (11 hand-written sites
  converted), one progress route, every kind in the tray and readable through MCP. Job
  rows carry a `subject`, so "busy with a backup" stops comparing titles (D-4). The
  client follows a job one way (D-3). (R-4)
- **Errors, one path.** Routes throw and one handler answers. `error` becomes the stable
  code and the message moves to `detail`, as §5 says. Every code is in
  `ERROR-HANDLING.md`. The client gets one `errorText` helper and recognises a 401 by
  code. (R-3, D-6)
- **Schemas on every route.** Body and params schemas in `containers.js` and the rest;
  response schemas on all 132 routes; one declaration form; unknown body keys refused
  (R-1, R-2, X-7). `routes/containers.js` and `routes/library.js` are rewritten to the
  standard of the current routes, with the library reads moved into its lib. A check
  fails a route without schemas.
- **Orchestration into the glue.** Backup orchestration in one place (R-5); the follow-ups
  of rename, delete and PATCH out of the routes, so MCP gets them too and the operation
  lock is taken in one place (R-6).
- Outbound `fetch` in `cloudinit.js` and `oidc.js` goes through `lib/downloads`, and the
  lint covers it (R-8).
- Backlog: "Six job progress streams", "MCP's `get_job` reads only the operation job
  store", "A GET that starts a job", "Route errors carry the message, not a stable code",
  "`PATCH /api/containers/:name` has no body schema", "Deleting a VM leaves its
  `backup-status.json` entry", "A VM rename doesn't move its sidebar section".
- Behaviour changes, all on the wire and all needing spec edits: the error body, the job
  progress routes, `POST` for the package refresh, unknown keys refused.
- Risk: a response schema drops any field it does not list. Each route's answer is
  compared before and after on the test host.

### 4. Frontend data flow — M–L

Why here: graded "strained", and it needs phase 3's job and error shapes.

- One `useRecord` hook for "read on mount, numbered reads, follow a cue", replacing 11
  components and 3 store copies (D-1).
- One section-form hook, replacing the copied `form` / `original` / `init` blocks; the
  hook-dependency rule goes on (D-2).
- Topic and kind names as shared constants on both sides, with a check; an unknown job
  kind no longer empties the tray (D-7).
- `vmStore` and `containerStore` on one shared base (D-5).
- Inline errors can be dismissed; the SSE twin is merged; wrappers take a `signal`;
  `hostStore` and the unused exports go; bridge pickers follow their topic (D-9).
- Backlog, where the shared code closes them: "A VM deleted elsewhere leaves its open tab
  on an endless spinner", "The VM General section renders the list seed", "A VM rename
  navigates even after the user moved on", "Job-based host commands go idle before the
  re-read". The two that need frames to name their command stay in the backlog.

### 5. Manager internals — L

Why here: graded "workable", and the riskiest to touch: every step is checked on the
test host.

- Shared homes: change emitter (X-1, 33 copies), privileged-helper exec (X-2, 6 ways),
  logger (X-3, no `console.*` left).
- vmManager: one define helper that takes a per-VM lock (V-1, 13 sites); device XML built
  once for create and PATCH (V-2); one "is running" (V-3); firmware expressed one way
  (V-4); `updateVMConfig` broken up (V-5); no guessing Windows from the name (V-7).
- containerManager: one config read (C-1); `containerManagerCreate.js` split by domain,
  which empties the cycle exceptions (C-3); one rule for "restart required"; dead code
  out (C-6); the smaller duplicates (C-7, C-8). The stacked fallbacks are pruned one at a
  time, and only where the host shows the first rung always works (C-4).
- host, storage, mdns: silent catches logged or surfaced (V-6, 41 sites); the 5 s stats
  reads off the main thread's sync calls; the SMB and disk mount twins merged (V-11);
  mDNS reopens its bus (V-10).
- Needs two rulings first, brought with this phase's feature: what "strict manager"
  covers (C-5, V-8) and whether old backup shapes stay readable (V-9).
- Backlog: "VM restart-flag clear can revert a concurrent define", "A disk bus change off
  VirtIO always fails", "One rule for a container's restart required", "A timed-out avahi
  registration is never retried", and the main-thread half of "A hung CIFS mount blocks
  Node's filesystem calls".

### 6. Frontend components — M–L, mechanical

Why here: "workable", low risk, large in files touched. After phase 4, which edits the
same files.

- Primitives: Button, IconButton, Badge, Tabs, Field, ErrorBanner, ProgressBar,
  SubHeading; every caller converted (U-1, U-2). A check fails a raw `<button>` outside
  them.
- `DisksSection.jsx` and `VmNetworkInterfacesSection.jsx` each split into a create and a
  detail component (U-3). `ImageLibrary.jsx` rewritten (U-5). One editable sub-list for
  the four app UIs (U-4).
- Renames for §1 (U-6); one `formatBytes`; labels on icon buttons (U-7).
- Backlog: "Help icons rely on `title`".

### 7. Start-up, install and update — L

Next after phase 2 (moved up 2026-11-18). P-1 is a live defect, and its clean fix, like
P-3's, is a design and not a patch.

- **Migrations at start (P-3).** The backend runs the pending state migrations every time
  it starts, before it serves a request or starts a workload. A failed migration stops
  the start and says why. The updater, the installer and `wispctl` no longer run them:
  after an update, the health check sees the failed start and rolls back. Rule docs:
  CODING-RULES §16, ARCHITECTURE State, PRODUCTION Deploys; spec: UPDATES, State
  migrations.
- **One setup path that ends usable (P-1, P-4).** Install and update run the same
  re-runnable setup, so a step added to it reaches every host. It ends with VM and
  container networking working. The bridge is one of its steps: found or chosen first,
  so the steps that depend on it are written for it; applied last, through the host's
  own network tool, in a way that keeps the host's address. Nothing of ours is left to
  run afterwards. Backlog: "Setup strategy: one update-safe path", "A push to a fresh
  host needs `unzip` first".
- `DEPLOYMENT.md` as a contract for the result (P-8), and the README's install section.
- A later feature of this phase, which may wait until after phase 6: the nine helpers on
  one dialect, with shell rules added to CODING-RULES §12 (P-6); `sanity.sh` can fail;
  exec bits; one source for the version and the file list; one `idle_run`; legacy
  cleanups expire; stale `wispctl` commands (P-7). Backlog: "SMB shares without a
  password can't be mounted", "OS upgrade runs inside wisp.service", "`release.sh` can
  stop halfway through".

### 8. Docs and the rule sweep

Each item is the user's call and is brought as a decision when the phase is reached.

- Cut the sections of the specs that mirror code (O-2); this replaces the backlog's
  "Split CONTAINERS.md and UI.md by area", which would move them unchanged.
- One home per fact (O-3); the 12 contradictions (O-4); `DEPLOYMENT.md` (P-8); README,
  screenshots, `web/`, the 2026-04-28 plans (O-6).
- Sweep the rule sections never swept (§1, §2, §5, §10, §11, §15, §16; FRONTEND-RULES
  Design, Files, UI patterns) against the result.
- Check each of the seven rules written as met (X-8) is now met.
- Close by re-counting the audit's measures.

## Targets

| Measure | Now | After |
|---|---|---|
| Ways a route answers an error | 4 | 1 |
| Ways a job is started / job stores / progress routes | 2 / 6 / 7 | 1 / 1 / 1 |
| Body schemas, `containers.js` commands | 1 of 9 | 9 of 9 |
| Response schemas | 78 of 132 | all |
| Silent steps in a new job command | 6 of 12 | 1 or 0 |
| Import cycles | 5 | 0, checked |
| Hand-written change emitters | 33 | one helper per fence |
| Ways to call a privileged helper | 6 | 1 |
| "Read XML, change, define" written out | 13 | 1, locked |
| Silent catches in `host` | 41 | 0 |
| Hand-written "read and follow" in the client | 14 | 1 hook |
| Distinct button class strings | 91 | primitives only |
| Rules written as met that are not | 7 | 0 |

## Not in this plan

- New features, and the backlog's ideas (sidebar ordering, live memory, SSO, vTPM,
  seccomp opt-out, macOS containers, config backup, migration history, adopt kept disks).
- Backlog items that are platform investigations, not code shape: the Samba container,
  the HTTP/1.1 connection limit, stuck-probe recovery, VLAN filtering, `drivetemp`, Arch
  `DBPath`, helper hardening leftovers.
- TypeScript, a database, an event bus: recorded decisions the audit found no reason to
  reopen.
