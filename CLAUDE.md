@AGENTS.md

Claude Code reads `CLAUDE.md`, not `AGENTS.md`; the import above bridges the two. All
rules live in `AGENTS.md` — add instructions here only when they apply to Claude Code
alone.

- Branch work happens in a **git worktree under `.claude/worktrees/`** (gitignored via
  `.claude/`), one per branch — the main checkout stays on `main`, clean, for
  discussion, planning, and review. A worktree must never hold anything worth losing.
  Run `git worktree prune` after deleting one.
