# Wisp — Project Rules

> Entry point for any coding agent working on this project. One home per topic.
>
> **The rules — read them before any other reading or writing in the project:** this file
> — how we work (working method and hard rails); `docs/wisp.md` — why the project
> exists, and the philosophy that binds its design; `docs/CODING-RULES.md` — how code is
> written, tested and debugged (generic principles plus the project's language rules,
> §12); `docs/TECH-STACK.md` — what it is built with, and why; `docs/ARCHITECTURE.md` —
> the system's shape (boundaries, data flow, where state lives, how it runs);
> `docs/FRONTEND-RULES.md` — how UI code is written, and the project's design;
> `docs/PRODUCTION.md` — what facing real users adds.
>
> **Read as the work needs them:** `docs/specs/<SUBSYSTEM>.md` — the contract docs, one
> per subsystem; `docs/features/<feature>.md` — work being built; `docs/BACKLOG.md` —
> deferred items; `docs/reviews/` — audits.
>
> **Structure:** sections marked `[PROJECT]` are the project's own, filled in per project
> and edited as it grows. Everything else is stable methodology shared with the template
> this structure comes from: change it deliberately. When the project legitimately
> replaces a methodology section with its own version, mark the replacement `[PROJECT]`
> too.

## Interacting with the user

Assume the user has technical knowledge. Answer concisely but clearly. Prefer lists over
long prose. Use plain English, not niche or trendy terminology.

## Project Facts `[PROJECT]`

- Runtime: Node.js 24+ LTS, ESM, plain JavaScript (no TypeScript) — see
  `docs/TECH-STACK.md`. Package manager: npm — do not introduce others.
- Commands — keep this line current. Backend dev
  `cd backend && NODE_ENV=development npm run dev` (→ `127.0.0.1:8080`) · Frontend dev
  `cd frontend && npx vite --port 5173` (proxies `/api` + `/ws` to `:8080`) · Frontend
  build `cd frontend && npm run build` · Import check `npm run check-imports` · Fence
  lint `npm run check-fences` · Route access table `npm run route-access` · Release (user-initiated) `scripts/release.sh`.
  No test suite: verification is CODING-RULES §14.
- Hard constraints: a single-user manager for KVM/QEMU VMs (libvirt over DBus) and
  containerd containers on one Linux host, reached from a browser on the same network.
  It runs on that host under systemd, never in a container, and updates itself from
  GitHub Releases.

## Small work

A bug fix, rename, config tweak or isolated change (roughly <50 lines, one subsystem): do
it, then run the relevant tests. No feature, no spec change. When unsure whether work is
small, ask.

## Everything else: request → features → build

1. **Request → features.** Discuss a request with the user until its features, and the
   spec changes they need, are written and the user agrees to them. Split very large
   work, a project's first build above all, into a set of features, built in the order
   agreed with the user.
2. **One builder.** From the session that agreed the features, start one subagent, in a
   context of its own, for all of them: name the features to build, in order, and the
   specs to keep in mind. The builder reads this file and follows it. Without subagents,
   build in your own session.
3. **Open points first.** Builder: read the features, their specs and the code they
   touch. Send what they leave open, or where the code contradicts them, back to the
   design session first, each point as its own decision with a recommendation. Design
   session: settle them with the user and pass the answers on. Builder: then build,
   milestone by milestone.
4. **A milestone is done** when each of its acceptance criteria was run and observed as
   CODING-RULES §14 says: Wisp has no test suite. Builder: then stop and report. Design
   session: have it reviewed, then continue the same builder with the findings and the
   next milestone. `[PROJECT]`

## Review

Have any work beyond small work reviewed independently by a subagent. Give it the change
and the feature or spec behind it, not your reasoning, to check against them and the
rules (this file's header). It reads whatever code it needs to follow what the change
touches, and reports only on the change and what it affects: the whole app is an audit's
job (`docs/reviews/`). Without subagents, ask the user to run the review in a fresh
session, given the same. Fix or backlog each finding.

## Scope

- Never silently fix or refactor unrelated code mid-session: if it isn't in scope, add it
  to `docs/BACKLOG.md` as a structured entry. The user can also ask to "add this to the
  backlog" directly.
- YAGNI: build what the task requires, nothing speculative.

## Documentation

Document **decisions and contracts, not implementations**: the code is the source of
truth, and a doc that mirrors it goes stale.

**The spec is the user's.** `docs/wisp.md`, `docs/specs/` and `docs/features/` record
what was agreed with the user. Never edit them to match what was built: fix a divergence
in the code or raise it with the user, and change a spec only once the user agrees.

**Decisions live where their topic lives — inline, dated.** Record a settled decision in
the doc that owns its topic (see the header), tagged `(settled YYYY-MM-DD)`, with its
reasoning, and what was rejected when that matters. One home per decision; no separate
decision log. Record only decisions that settle a spec or a change: an idea turned down
while brainstorming or speccing goes nowhere, unless the user asks for a backlog entry.
What a code comment may say: `docs/CODING-RULES.md` §10.

- `docs/specs/<SUBSYSTEM>.md` — one per subsystem, **written with the first feature that
  settles its behavior**, never extracted later from code. It holds the subsystem's
  purpose, its principles, its genuine contracts (external API shapes, invariants,
  protocol behavior) and its settled decisions. An implementation change that alters no
  agreement needs no doc edit.
- `docs/features/<feature>.md` — one per piece of work bigger than a small change: what
  it is for, which specs it adds or changes, and its **milestones** in order. A milestone
  is the smallest piece of the work after which something works end to end. Give each its
  acceptance criteria: observable, checked by running something, never a quality
  judgement. A feature that fits in one go has one milestone. Never put a spec's content
  in a feature: contracts live in the specs. Remove the feature once its last milestone
  is reviewed, like a backlog entry.
- `docs/ARCHITECTURE.md` — update it in the change that alters the shape.
- `docs/BACKLOG.md` — deferred bugs and ideas (see Scope). Remove a resolved entry **in
  the same change**: git history is the archive.
- `docs/reviews/<YYYY-MM-DD>/AUDIT.md` — code/security audits; add `IMPLEMENTATION.md`
  when an audit yields substantial follow-up work, grouped by severity, each item with
  file, line, and fix sketch.
- `CHANGELOG.md` — **update it before every push**: a new dated section at the top
  (`## YYYY-MM-DD`), entries grouped New Features / Bug Fixes, one terse intent-level
  line each; never touch older sections. When cutting a release, leave it uncommitted:
  `scripts/release.sh` folds it into the release commit. `[PROJECT]`

## Git

- Use git as you go, with the usual conventions: conventional-ish commit messages, one
  logical change per commit, each committed as it works, not one commit at the end.
- Build features on a branch, and **rebase it onto main before the ff merge**, so main
  never freezes: small unrelated work keeps landing on main while feature work is in
  flight. Wait out only a same-file collision with the branch.
- Never push, force-push, or rewrite main's history without being asked.
- **Tags are anchors.** Tag main with an annotated tag **immediately before work on
  features begins**: the tag names the world the work started from, for diffing and for
  bailing out. Say in the message, in one line, what the anchor holds. Name anchors
  `anchor/<topic>`, never `v*`: that prefix triggers the release workflow. `[PROJECT]`
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
