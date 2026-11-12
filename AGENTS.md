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
> **Structure:** sections marked `[PROJECT]` are the project's own — filled in per
> project and edited as it grows. Everything else is stable methodology shared with the
> template this structure comes from: change it deliberately, not casually. When a
> methodology section is legitimately replaced by a project-specific version, the
> replacement is marked `[PROJECT]` too.

## Interacting with the user

Assume the user has technical knowledge. Use concise but clear responses. Prefer lists of
items over long prose paragraphs. Avoid terminology that is niche or trendy, prefer plain
english.

## Project Facts `[PROJECT]`

- Runtime: Node.js 24+ LTS, ESM, plain JavaScript (no TypeScript) — see
  `docs/TECH-STACK.md`. Package manager: npm — do not introduce others.
- Commands — keep this line current. Backend dev
  `cd backend && NODE_ENV=development npm run dev` (→ `127.0.0.1:8080`) · Frontend dev
  `cd frontend && npx vite --port 5173` (proxies `/api` + `/ws` to `:8080`) · Frontend
  build `cd frontend && npm run build` · Import check `npm run check-imports` · Route
  access table `npm run route-access` · Release (user-initiated) `scripts/release.sh`.
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

1. **Request → features.** A request is discussed with the user until its features, and
   the spec changes they need, are written and the user agrees to them. Very large work,
   a project's first build above all, is a set of features, built in the order agreed
   with the user.
2. **One builder.** The session that agreed the features starts one subagent, in a
   context of its own, for all of them, naming the features to build, in order, and the
   specs to keep in mind; it reads this file and follows it. An agent without subagents
   builds in its own session.
3. **Open points first.** The builder reads the features, their specs and the code they
   touch. What they leave open, or where the code contradicts them, goes back to the
   design session first, each point as its own decision with a recommendation; the design
   session settles them with the user and passes the answers on. Then the builder builds,
   milestone by milestone.
4. **A milestone is done** when each of its acceptance criteria was run and observed as
   CODING-RULES §14 says: Wisp has no test suite. The builder then stops and reports; the
   design session has it reviewed and continues the same builder with the findings and the
   next milestone. `[PROJECT]`

## Review

Any work beyond small work gets an independent review by a subagent. It is given the
change and the feature or spec behind it, not your reasoning, and checks the change
against them and the rules (this file's header). It reads whatever code it needs to
follow what the change touches, and reports only on the change and what it affects; the
whole app is an audit's job (`docs/reviews/`). An agent without subagents asks the user
to run the review in a fresh session, given the same. Fix or backlog each finding.

## Scope

- Don't silently fix or refactor unrelated code mid-session: either it's in scope, or it
  goes to `docs/BACKLOG.md` as a structured entry. The user can also ask to "add this to
  the backlog" directly.
- YAGNI: build what the task requires, nothing speculative.

## Documentation

Document **decisions and contracts, not implementations**: the code is the source of
truth, and a doc that mirrors it goes stale.

**The spec is the user's.** `docs/wisp.md`, `docs/specs/` and `docs/features/`
record what was agreed with the user. Never edit them to match what was built: a
divergence is fixed in the code or raised with the user, and a spec changes only once the
user agrees.

**Decisions live where their topic lives — inline, dated.** A settled decision is recorded
in the doc that owns its topic (see the header), tagged `(settled YYYY-MM-DD)`, with the
reasoning, and what was rejected when that matters. One home per decision; no separate
decision log. Only decisions that
settle a spec or a change are recorded: an idea turned down while brainstorming or
speccing is written nowhere, unless the user asks for a backlog entry. What a code comment
may say: `docs/CODING-RULES.md` §10.

- `docs/specs/<SUBSYSTEM>.md` — one per subsystem, **written with the first feature that
  settles its behavior**, never extracted later from code. It holds the subsystem's
  purpose, its principles, its genuine contracts (external API shapes, invariants,
  protocol behavior) and its settled decisions. Implementation changes that alter no
  agreement require no doc edit.
- `docs/features/<feature>.md` — one per piece of work bigger than a small change: what
  it is for, which specs it adds or changes, and its **milestones** in order. A milestone
  is the smallest piece of the work after which something works end to end. Each has its
  acceptance criteria: observable, checked by running something, never a quality
  judgement. A feature that fits in one go has one milestone. A feature never holds a
  spec's content; contracts live in the specs. Once its last milestone is reviewed, it is
  removed, like a backlog entry.
- `docs/ARCHITECTURE.md` — updated in the change that alters the shape.
- `docs/BACKLOG.md` — deferred bugs and ideas (see Scope); a resolved entry is **removed
  in the same change**, git history is the archive.
- `docs/reviews/<YYYY-MM-DD>/AUDIT.md` — code/security audits; add `IMPLEMENTATION.md`
  when an audit yields substantial follow-up work, grouped by severity, each item with
  file, line, and fix sketch.
- `CHANGELOG.md` — **updated before every push**: a new dated section at the top
  (`## YYYY-MM-DD`), entries grouped New Features / Bug Fixes, one terse intent-level line
  each; older sections are never touched. When cutting a release it stays uncommitted —
  `scripts/release.sh` folds it into the release commit. `[PROJECT]`

## Git

- Use git as you go, with the usual conventions: conventional-ish commit messages, one
  logical change per commit, committed as each piece works — not one commit at the end.
- Work on features gets a branch; the branch **rebases onto main before the ff merge**,
  so main never freezes — small unrelated work keeps landing on main while feature work
  is in flight. Same-file collisions with the branch are the one case to wait out.
- Never push, force-push, or rewrite main's history without being asked.
- **Tags are anchors.** An annotated tag on main, tagged **immediately before work on
  features begins** — the tag names the world the work started from, for diffing and for
  bailing out. The message says what the anchor holds in one line. Anchors are named
  `anchor/<topic>`, never `v*`: that prefix triggers the release workflow. `[PROJECT]`
- **Remotes and releases:** plain `git push` goes to `cala`, the day-to-day private
  remote, which also takes the anchor tags; `github` is for releases only — it feeds the
  release workflow that builds the self-update tarball. No GitHub PRs. Small work and
  docs-only changes commit directly to main. Releases are batched — don't suggest cutting
  one after individual changes; the release flow is `scripts/release.sh` (version bumps,
  changelog fold, `v*` tag). `[PROJECT]`

## Deployability

- Fixes for deployment or setup issues land in the codebase or `scripts/`, never as notes
  about manual steps.
- How Wisp is installed, updated and released: `docs/PRODUCTION.md`, Deploys.
  `[PROJECT]`
