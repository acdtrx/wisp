# Privileged helpers: one dialect, every argument checked, one way to install

The last feature of phase 7 of `docs/reviews/2026-11-17/IMPLEMENTATION.md` (findings P-6
and P-7 of that audit). The facts below were taken on `main` on 2026-11-22, after phase 5
gave the backend one way to call a helper.

## What it is for

Wisp's backend runs as an ordinary user and reaches root through nine small bash scripts
and an updater.
They are the most privileged code Wisp has, and the least held to rules.

- **Nine helpers speak four dialects.** Errors go to stdout in one, to stderr in six, into
  JSON in two. "Not found" is an exit code in one helper, a sentence the caller matches
  in another, and looks like success in two more. Only two helpers put a time limit on what
  they run; the others can hang until the backend gives up, leaving the root process
  behind.
- **Some arguments reach a root command unchecked.** A mount's `uid`, `gid` and
  credentials path are joined into the mount options, so a comma adds any option. A
  disk's `uuid` is not checked, so `../../sda1` names any block device. A removable disk
  is mounted honouring setuid programs and device files. The NVRAM copy checks its paths
  and then follows a symlink put there afterwards. The network helper takes any network
  namespace path, the host's own included.
- **Nothing checks shell beyond `bash -n`**, and no helper has a test.
- **Setup never removes a helper.** A helper a newer release stops shipping stays
  installed with its sudo rule. Two old ones are removed by a list that never ends.
- **An update and an install copy the tree by different rules.** An install keeps all of
  `config/`; an update keeps five named files and deletes the rest. Stop, copy, set up,
  start is written twice.
- Smaller: a share without a password cannot be mounted; `release.sh` can stop with six
  files changed and nothing committed; `wispctl` keeps commands that go round systemd or
  uninstall half of Wisp; two helper subcommands have no caller.

## Decisions

### Who the helpers defend against (settled 2026-11-22)

- **The service user is root's equal, by design**: it is in the `libvirt` group and it
  stages the tree an update installs. The helpers do not try to contain it.
- **The helpers defend against data**: a share name, a disk's label or UUID, a
  container's name, a path. Every argument is checked against what it may be before it
  reaches a root command, so nothing a disk, a share or a request body carries can add
  an option or name another file.
- Not done: a sudo rule per argument, a signed release, root checking the download
  again. Each would only matter against the service user itself.

### One dialect

Written into CODING-RULES §12 as shell rules, with the helpers as their first users:

- **Called as** `wisp-<name> <subcommand> <arguments in order>`. No flags, no
  environment variable chooses a program.
- **The answer is on stdout** (lines or JSON, as the helper's contract says). **An error
  is one line on stderr.** Nothing else is printed.
- **Exit codes mean the same in every helper**: 0 done; 64 the arguments are wrong; 2 the
  thing named is not there; 75 busy, try again; 1 anything else. The backend reads the
  code, never the sentence.
- **Every argument is checked**: a name against its pattern, a path resolved and held
  under the folders it may be in, an option against a list. `--` goes before anything a
  caller supplied.
- **A helper limits what it runs.** A signal sent to `sudo` does not reach the helper's
  child, so the helper bounds each command that can hang, with one `bounded` they all
  share.
- **A helper that could not do its job says so**: no empty answer that reads like
  "none", no success for a delete that failed.
- **The shared parts live in one file** installed beside the helpers and read by them.
- **shellcheck runs in `npm run check`** on every shell file, and is required: the
  check fails without it (settled 2026-11-22). Each helper has a test of its refusals,
  run without root against stand-in commands.

### Setup installs exactly the set

- The helpers and sudo rules of this release are the whole set: setup removes any
  `wisp-*` helper and sudo rule it finds that is not in it. The two-name cleanup list
  goes. A rollback then removes what the failed release added.
- A subcommand with no caller goes (`wisp-netns ipv4`, `wisp-os-update check`).
- `wispctl` keeps what the docs describe: `password`, and `svc start`, `stop`, `restart`,
  `logs`. `local` (a second way to run Wisp, round systemd) and `svc uninstall` (removes
  one unit and leaves the rest) go; a real uninstall is a backlog entry.
- A file the helpers folder holds that is not a helper moves to setup (`wisp-port.sh`).

### An update is an install with a way back (settled 2026-11-22)

- The updater takes the lock, stops Wisp, keeps a copy, then runs **the new tree's own
  install** (the copy and the setup an install runs), starts Wisp as the health check,
  and puts the copy back when any of it fails.
- One rule says what an install keeps (`config/`'s own files) and removes what the new
  tree dropped, for an install and an update alike.

## Behaviour changes

- A removable disk is mounted without setuid programs and device files.
- A share without a password mounts as a guest.
- A failed RAM read says it failed, where it showed no modules.
- A helper a release no longer ships is removed at the update.
- An update keeps the same files an install keeps.
- `wispctl local …` and `wispctl svc uninstall` are gone.

## Constraints

- The helpers stay bash, and the sudo rules stay one per helper, written by setup.
- Nothing changes on the wire except the answers named above.
- shellcheck is the one new tool, for development only.
- Every helper is run on the test host through Wisp. What can break a host (a bridge, a
  mount, a power command, an update and its rollback) runs in a nested
  throwaway VM, never on the test host itself. An update is run from a tree staged by
  hand; nothing is downloaded from a release.
- The method of phase 5: the builder sends its open points before each milestone,
  builds, and each milestone gets one review for defects a user would hit. The design
  session writes the rules and the specs.

## Milestones

### 1. One dialect, every argument checked

- Each helper answers on stdout, fails with one line on stderr and the shared exit
  codes; the backend reads no sentence from a helper.
- Each helper refuses each wrong argument with exit 64 before it runs anything: a test
  per helper, run without root.
- On the nested VM: a mount with a comma in its `uid`, a disk `uuid` of `../../sda1`, a
  share starting with `-`, an NVRAM target that is a symlink, a network namespace outside
  Wisp's own: each refused. A removable disk mounts with `nosuid,nodev`. A share without
  a password mounts.
- A helper whose command hangs ends within its limit and leaves no root process behind.
- `npm run check` runs shellcheck on every shell file and passes.

### 2. Setup installs exactly the set

- A stand-in `wisp-old` helper and sudo rule put on the nested VM are gone after setup.
- `wispctl` lists only its documented commands; `release.sh` with a wrong changelog
  stops before it changes a file.
- No file in the helpers folder is something else; every script's git mode matches how
  it is used (a check holds it).

### 3. An update is an install with a way back

- On the nested VM, an update from a hand-staged tree installs it and Wisp runs the new
  version; a file left in `config/` by hand is treated the same by an install and an
  update.
- A staged tree whose Wisp cannot start is rolled back: the old version runs, and a
  helper only the new tree had is gone.
- Stop, copy, set up and start are written once.

## Not in this feature

- A signed release, and root checking the download.
- The OS upgrade in a unit of its own, so that a Wisp restart cannot stop it half way
  (the user's choice, 2026-11-22): it stays in the backlog, "OS upgrade runs inside
  wisp.service".
- A complete uninstall; ifupdown hosts; the readers of a dead share: backlog.
