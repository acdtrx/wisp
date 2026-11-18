# Safety net

Phase 1 of `docs/reviews/2026-11-17/IMPLEMENTATION.md`. Findings X-4, X-5, X-6 and P-2 of
that folder's `AUDIT.md`.

## What it is for

Today nothing says a change broke something until the code runs on a host: an undefined
name, a missing darwin stub, an import cycle and a script with a syntax error all pass
every check, and the release workflow publishes without running any. The phases after
this one convert a lot of code. This feature gives them, and every later change, one
command that fails on those mistakes, and makes a release impossible while it fails.

## What it changes in the docs

- `TECH-STACK.md`, Testing & lint: ESLint as a dev-only dependency with correctness rules
  only; a unit harness on `node --test` for code with no platform behind it; "No
  automated test suite" narrows to "manager paths have no automated tests" (settled
  2026-11-18).
- `CODING-RULES.md` §14: `npm run check` and `npm test` join the list; what each covers.
- `AGENTS.md`: the commands line in Project Facts, and the clause in "A milestone is
  done" that said Wisp has no test suite.
- `specs/DEPLOYMENT.md` and `specs/UPDATES.md`, only where they list the release
  workflow's steps: the gate, in a line. In `specs/UPDATES.md` also the release-script
  row: `release.sh` runs the check first, and the repo root now has a lockfile.
- `BACKLOG.md`: "The backend's import graph isn't checked for cycles" and "Nothing
  catches a use of an undefined name" are removed.

No API, UI or stored-data change.

## Constraints

- Dev tools never reach a host: ESLint, its React hooks plugin and `globals` (the lists
  of browser and Node global names `no-undef` needs) are dev dependencies of the repo
  root, and test files are not in the release tarball.
- Rules are correctness rules only: `no-undef`, `no-unused-vars`, `no-dupe-keys`,
  `react-hooks/rules-of-hooks`. No style rule. `react-hooks/exhaustive-deps` stays off
  until phase 4.
- The new checks join the existing scripts (`check-imports`, `check-fences`) where they
  fit, in the same dependency-free style. ESLint is the one exception.
- A check that fails names the file and line.
- Every violation the checks find in today's code is fixed in this feature, not allowed
  by a list. The one list is the three containerManager cycles, each named, which phase 5
  removes.
- Fixing a violation changes no behaviour. An unused import or variable is deleted; a
  finding that turns out to be a real defect is reported as an open point first.

## Milestones

### 1. One check command

`npm run check` at the repo root runs, and fails if any of them fails:

- the import check, now with facade parity: every name a facade takes from its
  implementation is exported by both `linux/` and `darwin/` (X-4). It also checks every
  named import between backend files: the file imported from exports that name. The Mac
  never loads the `linux/` files, so nothing else would;
- the fence check, now with a cycle check over static and dynamic imports (X-5). The
  cycles `vmManagerList.js` ↔ `vmManagerPendingRestart.js`, `avahi.js` ↔ `forwarder.js`
  and `downloads/downloadUtils.js` ↔ `downloadFromUrl.js` are broken; the three in
  containerManager are the named exceptions;
- ESLint over `backend/` and `frontend/src/` (X-6). The five `eslint-disable` comments
  left from an earlier setup are removed;
- `bash -n` over every shell script and helper in the repo, found by a shell shebang or
  a `.sh` extension, not by a hand-kept list.

Acceptance:

- `npm run check` passes on the branch; so do the frontend build and the dev backend's
  boot on macOS.
- Each of these, added on purpose and then reverted, makes `npm run check` fail and name
  the file: a call to an undefined function in a frontend component; the same in a
  backend file; an export removed from `containerManager/darwin/index.js`; a misspelled
  named import in a file under a `linux/` folder; an import that closes a new cycle; a syntax error in `backend/scripts/wisp-updater`.
- The cycle exceptions list holds exactly three entries.
- On the dev stack: a download from a URL into the image library completes, and the URL
  check answers for a good and a bad URL.
- On the test host with the branch deployed: the VM list loads; a config change on a
  running VM shows "restart required" and a restart clears it; a container resolves
  another workload's `.local` name; a workload's `.local` name resolves from the LAN.

### 2. Unit harness

`npm test` at the repo root runs `node --test` over the test files. First tests, for
`frontend/src/api/sse.js`, `frontend/src/api/events.js`, `store/vmStore.js` and
`store/containerStore.js`, pin what they do today:

- `sse.js`: frames split across chunks are delivered whole; a dropped stream reconnects;
  closing stops the reconnect; a 401 logs the session out, goes to the login page and
  does not reconnect.
- `events.js`: all subscribers share one stream; a dropped stream tells every subscriber;
  a topic's last frame is kept across the drop and given to a late subscriber, except on
  `changes`; the connect frame `{ kind: "all" }` reaches every change handler.
  `sendAndAwaitTopic` ends on the topic's next matching frame, `sendAndAwaitChange` on a
  change naming its kind and id or on `{ kind: "all" }`; both end after 30 s without one,
  and both only send when no stream is open.
- the two stores: an older read that answers after a newer one does not overwrite it; a
  list frame updates the list; a rename is followed; a deleted workload is deselected.
  An empty list frame deselects in `vmStore` and not in `containerStore`.

Acceptance:

- `npm test` passes, and `npm run check` runs it.
- For one behaviour per module, breaking it in the source makes its test fail (observed,
  then reverted).
- A tarball built by the release workflow's staging step holds no test file.

### 3. The release gate

- `release.yml` runs `npm run check` before the frontend build; a failure stops the
  workflow before anything is published (P-2).
- `scripts/release.sh` runs the same check first and stops before it changes a version or
  creates a tag, so a failure is met before the tag is pushed.
- The docs changes listed above.

Acceptance:

- In a throwaway clone with a syntax error added to a helper, `scripts/release.sh` stops
  with the check's output; no version changed, no tag created.
- The workflow's steps up to and including the check, run by hand in a clean clone on
  Node 24, pass. The workflow itself is first observed at the next release; say so in
  the report.

## Not in this feature

- The hook-dependency rule: phase 4. The containerManager cycles: phase 5.
- Tests for backend code: they come with the phases that give it pure seams.
- Any fix beyond what the new checks flag.
