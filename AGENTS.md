# Wisp — Project Rules

> Entry point for any coding agent working on this project. One home per topic.
>
> **Read before any other reading or writing in the project:**
>
> - this file — how work is done;
> - `docs/wisp.md` — why the project exists, and the principles that bind its
>   design;
> - `docs/CODING-RULES.md` — how code is written, tested and debugged (§12: the language
>   rules);
> - `docs/TECH-STACK.md` — what it is built with;
> - `docs/ARCHITECTURE.md` — the system's shape: boundaries, data flow, where state
>   lives, how it runs;
> - `docs/FRONTEND-RULES.md` — how UI code is written, and the project's design;
> - `docs/PRODUCTION.md` — what facing real users adds.
>
> **Read as the work needs them:** `docs/specs/<SUBSYSTEM>.md` — the contracts, one per
> subsystem; `docs/features/<feature>.md` — work being built; `docs/BACKLOG.md` —
> deferred items; `docs/reviews/` — audits.
>
> **Structure:** sections marked `[PROJECT]` are the project's own. The rest is
> methodology shared with the template this structure comes from: change it deliberately,
> and mark a section the project replaces `[PROJECT]`.

## Interacting with the user

Assume the user has technical knowledge. Answer concisely but clearly. Prefer lists over
long prose. Use plain English, not niche or trendy terminology.

## Project Facts `[PROJECT]`

- Runtime: Node.js 26+ LTS, ESM, plain JavaScript (no TypeScript) — see
  `docs/TECH-STACK.md`. Package manager: npm — do not introduce others.
- Commands — keep this line current. Backend dev
  `cd backend && NODE_ENV=development npm run dev` (→ `127.0.0.1:8080`) · Frontend dev
  `cd frontend && npx vite --port 5173` (proxies `/api` + `/ws` to `:8080`) · Frontend
  build `cd frontend && npm run build` · All checks `npm run check` (imports, unused
  exports, fences, ESLint with the wire's names, shell scripts, bounds, refusal codes,
  unit tests, setup's Python tests; needs `npm ci` at the root and in `frontend/`, and
  `python3`) · Lint `npm run lint` · Unit tests `npm test` · Import check
  `npm run check-imports` · Unused-export check `npm run check-exports` · Fence
  lint `npm run check-fences` · Route access table `npm run route-access` · Release
  (user-initiated) `scripts/release.sh`.
  Manager paths have no automated tests: verification is CODING-RULES §14.
- Hard constraints: a single-user manager for KVM/QEMU VMs (libvirt over DBus) and
  containerd containers on one Linux host, reached from a browser on the same network.
  It runs on that host under systemd, never in a container, and updates itself from
  GitHub Releases.

## Small work

A change of roughly <50 lines in one subsystem that alters no spec (a bug fix, a rename,
a config tweak): do it, run the relevant tests, commit. It needs no feature file and no
review. When unsure whether work is small, ask.

## Everything else: features

A **feature** is one capability a user can name. It gets one file, one branch, one
builder, one review and one merge. Split a feature that needs more than about four
milestones.

A **milestone** is one behaviour a user can observe, built through every layer it
crosses (storage, server, transport, client), with its tests. Never make one of a layer,
of a subsystem nothing calls yet, or of a task (tests, docs, polish, refactoring). Where
there is no UI, the user is the caller of the public interface. The first milestone of a
first build is the thinnest path through every layer, started by its real command, with
one e2e test. Give each milestone acceptance criteria: observable, checked by running
something, never a quality judgement. Split a milestone that needs more than about
eight.

Three roles: the **design session** agrees the features with the user and runs the
build; a **builder** builds one feature; a **reviewer** reviews one.

1. **Agree the features.** Design session: discuss the request with the user until its
   features, and the spec changes they need, are written and the user agrees to them.
   Order them so each builds on those merged before it.
2. **One builder per feature.** Design session: for each feature in order, start a fresh
   subagent and name the feature and its worktree (Git); it reads this file and follows
   it. Start the next builder after the merge. Without subagents, build in your own
   session.
3. **Settle what blocks; decide the rest.** Builder: read the feature, its specs and the
   code it touches. Before building, send back only a contradiction between the docs or
   a choice that changes a spec, each with a recommendation. Decide everything else and
   record it (Documentation). Design session: settle what comes back with the user, and
   answer.
4. **Build milestone by milestone.** Builder: a milestone is done when each of its
   acceptance criteria has a unit test or, on a manager path, was run and observed as
   CODING-RULES §14 says, and `npm run check` and the frontend build pass. Commit it and
   go on to the next. After the last, report each criterion with its test or what was
   observed, the check's output and the decisions made. `[PROJECT]`
5. **Review, then merge.** Design session: have the feature reviewed (Review) and send
   the findings to the same builder. Builder: fix each finding or add it to the backlog.
   Design session: then remove the feature file, merge and tag (Git).

**Bring requirements that pull against each other to the user**, before building one
around the other: name both, the simpler design, and what it gives up. Do the same for
old behaviour that a rewrite would keep at the cost of a mechanism of its own, when no
spec asks for it. Whoever finds it raises it: the builder sends it back (step 3), the
reviewer reports it, and the design session asks the user before another round.

## Review

Have each feature reviewed before its merge, by a fresh subagent. Give it the branch,
the feature file and the specs behind it, never your reasoning.

Reviewer: check the change against its acceptance criteria, its specs and the rules
(this file's header), and run the suite. Read whatever code the change touches, and
report only on the change and what it affects: the whole app is an audit's job
(`docs/reviews/`). Give each finding its file and line. Mark as a blocker a finding that
breaks an acceptance criterion or a spec.

Have the same reviewer check the blockers' fixes; review nothing else twice. If that
check finds a blocker, an old one or a new one, stop: bring the issue behind the findings
to the user instead of starting a third round. Without subagents, ask the user to run the
review in a fresh session, given the same.

## Scope

- **The specs are the user's; the code is yours.** Within the work's scope, change
  whatever the work needs rather than working around the code you find, and when asked
  to rewrite, rewrite. Keep a behaviour because a spec asks for it, never because the
  code has it.
- Leave unrelated code alone: add what you find to `docs/BACKLOG.md`, never fix or
  refactor it in passing. The user can also ask to "add this to the backlog".
- YAGNI: build what the task requires, nothing speculative.

## Documentation

Document decisions and contracts, never implementations: the code is the source of
truth, and a doc that mirrors it goes stale.

- **The spec is the user's.** `docs/wisp.md`, `docs/specs/` and `docs/features/`
  record what was agreed with the user. Never edit them to match what was built: fix the
  code or raise the divergence with the user, and change a spec only once the user
  agrees.
- **Record a decision as a fact, in the doc that owns its topic** (see the header). Put
  its reasoning, and what was rejected, in the commit message: the commit dates it. Keep
  a reason in the doc only where a reader would otherwise undo the decision, in one
  clause. Keep no decision log. Record only what settles a spec or a
  change: an idea turned down goes nowhere, unless the user asks for a backlog entry.

What each doc holds:

- `docs/specs/<SUBSYSTEM>.md` — one per subsystem, written with the first feature that
  settles its behaviour, never extracted later from code: its purpose, its principles,
  its contracts (external API shapes, invariants, protocol behaviour) and its settled
  decisions. A change that alters no agreement needs no doc edit.
- `docs/features/<feature>.md` — what the feature is for, the specs it adds or changes,
  and its milestones in order, each with its acceptance criteria. Contracts live in the
  specs, never in a feature.
- `docs/ARCHITECTURE.md` — update it in the change that alters the shape.
- `docs/BACKLOG.md` — deferred bugs and ideas. Remove a resolved entry in the same
  change: git history is the archive.
- `docs/reviews/<YYYY-MM-DD>/AUDIT.md` — code and security audits. Add
  `IMPLEMENTATION.md` when an audit yields substantial follow-up work, grouped by
  severity, each item with file, line and fix sketch.
- `CHANGELOG.md` — **update it before every push**: a new dated section at the top
  (`## YYYY-MM-DD`), entries grouped New Features / Bug Fixes, one terse intent-level
  line each; never touch older sections. When cutting a release, leave it uncommitted:
  `scripts/release.sh` folds it into the release commit. `[PROJECT]`

## Git

- Commit as you go: one logical change per commit, each when it works, with a
  conventional-style subject (`feat:`, `fix:`, `docs:`). Put the reasoning behind a
  decision in the body.
- Build a feature on a branch, in a worktree of its own under `.worktrees/`, which
  `.gitignore` lists: the design session creates it and removes it after the merge.
  Rebase the branch onto main, then merge fast-forward. Small work keeps landing on main
  meanwhile: wait out only a same-file collision with the branch.
- Never push, force-push, or rewrite main's history without being asked.
- Tag main with an annotated tag named `anchor/<feature>` after each feature's merge, its
  message one line on what the tag holds. Never name one `v*`: that prefix triggers the
  release workflow. `[PROJECT]`
- **Remotes and releases:** plain `git push` goes to `cala`, the day-to-day private
  remote, which also takes the anchor tags; `github` is for releases only — it feeds the
  release workflow that builds the self-update tarball. Never open a GitHub PR. Commit
  small work and docs-only changes directly to main. Batch releases: never suggest
  cutting one after individual changes. Release with `scripts/release.sh` (version bumps,
  changelog fold, `v*` tag). `[PROJECT]`

## Deployability

- Land fixes for deployment or setup issues in the codebase or `scripts/`, never as notes
  about manual steps.
- How Wisp is installed, updated and released: `docs/PRODUCTION.md`, Deploys.
  `[PROJECT]`
