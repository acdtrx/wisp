# Docs and the rule sweep

Phase 8, the last, of `docs/reviews/2026-11-17/IMPLEMENTATION.md` (findings O-2 to O-6
and X-8 of that audit). The numbers below were taken on `main` on 2026-11-23, by four
read-only surveys.

## What it is for

The code was reshaped in seven phases; the docs and a few corners of the code were not.

- **About 230 KB of the 786 KB of specs mirrors the code**: module tables, file-by-file
  lists, step-by-step walks of a script. Those sections are where the wrong text is: the
  VM module list names a file that does not exist and misses five that do, `UI.md` still
  has a stats bar that is gone, the image library spec describes a page that is gone.
  Settled decisions are woven into them, about 55 KB, and must be kept.
- **About 20 KB is history**: how a bug was found, what an old release did, beyond the
  one-line reason a decision needs.
- **Docs contradict each other in 19 places**, and in each the code agrees with the
  newer text. Facts are written in two to five places (the keep rule, the update
  sequence, the error body, state migrations, the helpers' dialect).
- **The rule docs a reader must read first grew** from 113 KB to 131 KB.
- **The README is wrong in five claims and silent on about fifteen features.** Its seven
  screenshots are from April, in the old palette and layout, and show a personal domain,
  LAN and MAC addresses, a share path and a user name.
- **Leftovers**: a landing page under `web/` that advertises snapshots; three finished
  review folders; a release tarball that ships all of `docs/`, the development scripts
  and 42 test fixtures, and the README without its images.
- **The backlog** has 77 entries under one heading, three duplicate pairs, three entries
  already resolved, five that name things that are gone.
- **The rule sweep found 17 rules the code does not meet.** Twelve are code leftovers
  (helpers copied in several files, silent catches without a reason, two shells for a
  form in a modal, a folder named for a page shape that is gone). Five are rules that
  describe what the project has since decided differently.
- **One of the audit's seven "written as met and not met" rules is still not met**:
  errors stay visible. 81 catches drop an error with no reason given.
- **Two targets of the plan are not reached**: buttons are still written out by hand
  (69 distinct class strings, 186 buttons, no Button primitive), and a job kind left out
  of one list silently takes no lock.

## Decisions

### What a spec holds

- **A spec holds purpose, principles, contracts and settled decisions**, as AGENTS
  already says. A section that lists modules, files, functions, components or the steps
  a script takes is cut. A decision inside it is kept and moves to the part of the spec
  that owns its topic.
- **A decision is written as a fact, tagged `(settled YYYY-MM-DD)`**, as the shared
  template has it since 2026-11-19. Its reasoning, and what was rejected, are not in the
  doc: they belong to the commit message. A reason stays only where a reader would
  otherwise undo the decision, in one clause. This applies to every decision in the
  specs and the rule docs (289 and 44 tags today), not only to those in a cut section.
- **AGENTS and CODING-RULES take the template's text for this**: the Documentation rule,
  the commit rule ("put the reasoning behind a decision in the body") and the comment
  rule of §10 ("reasoning lives in the commit message").
- **The reasons already in the docs are not copied anywhere.** Each doc is cut in a
  commit of its own, so `git log -p` on the doc shows every reason that was removed.
- **History goes**: "before, …", how a bug was found, what an old release wrote.
- **The rule docs get the same treatment**, so the first read shrinks again.
- **One home per fact**: the other places keep a one-line pointer. The homes: the exec
  allowlist in CODING-RULES §7; install and setup in DEPLOYMENT; update, release and
  the keep rule in UPDATES; the helpers' dialect in CODING-RULES §12; the error body and
  codes in ERROR-HANDLING; the events stream in API; state migrations in UPDATES; the
  mount object in STORAGE; the overall folder tree in ARCHITECTURE; modal and table
  patterns in FRONTEND-RULES.
- **Where two docs disagree, the code decides**, and the doc is corrected. Where a spec
  states a contract the code breaks, it is brought as a finding: fix the code, or change
  the contract.

### Leftovers

- `web/` goes. The three finished review folders go (`2026-04-28`, `2026-10-16`,
  `2026-11-12`): git history is the archive. `2026-11-17` stays as the record of this
  plan; the private `2026-07-05` is not touched.
- **A release ships what a host runs**: the backend, the built frontend, `shared/`, the
  install and setup scripts, the unit templates, the config examples, the licence, the
  README and the changelog. Not `docs/`, the development scripts, test fixtures or the
  agents' instructions. An update then removes them from an installed host, by the keep
  rule.
- The backlog gets headings by area; duplicates are merged, resolved entries removed,
  stale references corrected.
- **The runtime moves to Node 26**, the current LTS line: what setup installs, what the
  release is built with, the stack doc, and `engines` in `package.json`. The five test
  files that use a mock option deprecated after Node 24 are moved to its replacement.

### The README and the screenshots

- The README says what Wisp is, what it does today, what a host needs, how to install
  and update (the hand update for an older install included), and where the docs are.
  Every claim in it is checked against a spec.
- **The screenshots are taken on a demo host**: a throwaway nested VM with made-up
  workloads, so nothing of a real network or person is in them. Seven images: a VM
  page, a VM console, a container page, the Host overview, Host management, a page on
  a phone, and one page in the dark theme. The Home page is not shown: it may be
  redone or removed.

### The code the sweep found

- **One way for each of these**: a byte formatter and a relative-time formatter, one
  shell for a form in a modal, one card, one import order held by the import check.
- **A catch that drops an error says why, or it does not drop it**: each of the 81 is
  logged, shown, or given its reason in a line. A check then refuses a silent catch
  without one.
- **Buttons are primitives**: `Button` and `IconButton`, every caller converted, and a
  check that refuses a raw `<button>` outside them.
- A stored record is written atomically everywhere; a colour is a token; the folder
  `components/sections/` goes, its files moving beside their one user.
- Rules that describe what was since decided differently are corrected, not the code.

## Behaviour changes

- None in what the app does. A release tarball is smaller, and an installed host loses
  its copy of `docs/` at the next update.
- A host gets Node 26 at its next update, as part of setup.
- A failed step that was silently dropped may now show in the journal.

## Constraints

- No spec gains a contract here. A contract that turns out to be missing is brought to
  the user, not written from the code (one is known: the Jellyfin app has no section).
- A cut never loses a settled decision: each spec's cut is checked against the survey's
  list of what to keep, and by a reviewer.
- The code changes follow the method of phases 5 and 7: a builder sends its open points
  first, each milestone gets one review.
- Screenshots come from a nested throwaway VM on the test host; nothing of the user's
  own workloads appears in them.

## Milestones

### 1. Facts first

- Every contradiction the surveys list is gone: a grep for each wrong sentence finds
  nothing.
- The backlog has headings; no entry is resolved, duplicated or names something gone.
- The unpushed changelog section has one line per change a user sees, none describing
  a state a later change undid.
- `web/` and the three review folders are gone and nothing refers to them.

### 2. The specs hold contracts

- AGENTS and CODING-RULES carry the template's three rules.
- Each spec is cut to the rule above, in a commit of its own. Every decision in the
  survey's keep list for it is found in the new text, as a fact with its date.
- Each duplicated fact has one home and pointers elsewhere.
- The specs total 610 KB or less (the survey's figure, taken before the reasons rule;
  the real total is counted and recorded); the first read is smaller than 113 KB.
- A reviewer, given the old and the new text, finds no settled decision lost, and no
  reason removed that a reader needs to keep from undoing a decision.

### 3. The code the sweep found

- `npm run check` holds the import order and refuses a silent catch without a reason.
- `npm run check` passes on Node 26 with no deprecation warning from the tests; a fresh
  install on the nested VM runs Wisp on Node 26.
- One byte formatter, one relative-time formatter, one modal form shell, one card.
- No file under `components/sections/`.
- The pages look and behave as before (compared on the test host).

### 4. Buttons are primitives

- No raw `<button>` outside the primitives; the check holds it.
- The pages look as before, on a desktop and on a phone, light and dark.

### 5. The release, the README and the screenshots

- A staged tarball holds no `docs/`, development script or fixture; an install and an
  update from it work on the nested VM.
- The update moves a host on Node 24 to Node 26; an update made to fail rolls back and
  leaves Wisp running.
- Every claim in the README is true; the seven screenshots are of today's pages.

### 6. Close

- The audit's measures are counted again and recorded in the plan, with what was not
  reached.

## Not in this feature

- New features, and the backlog's ideas.
- A spec section for the Jellyfin app: brought to the user as its own question.
