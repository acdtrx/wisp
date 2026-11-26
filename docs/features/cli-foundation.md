# The CLI, installed and signed in

Agreed with the user on 2026-11-26, as the fourth step of making Wisp work out of the
box. It follows the image upload; "Containers from the CLI" follows it.

## What it is for

A coding agent reaches Wisp through MCP, which is a small set of tools, or through the
REST API, which it has to be taught. With this feature Wisp carries a command-line
client of its own version, `wisp`: one binary with nothing to install beside it, that an
agent or the user installs with one line, signs in with an API token, and learns from
its help. This feature builds it, serves it, signs it in and gives it the commands that
read. The commands that change containers are the next feature.

## The specs it adds or changes

Written by the design session with this file, and agreed with it:

- **New:** `specs/CLI.md`, the whole contract. This feature builds its sections Getting
  it, Signing in, Version check, the shared behaviour, and the commands that read:
  `login`, `logout`, `profiles`, `default`, `version`, `update`, `help`,
  `containers list | show | logs`, `images list`, `jobs list | wait`.
- `specs/API.md` (the `/api/cli` routes, the `Wisp-Cli-Version` header),
  `specs/AUTH.md` (the `public` routes), `specs/UI-HOST.md` (the install line),
  `specs/MCP.md` (the instructions' line on the CLI), `specs/DEPLOYMENT.md` and
  `specs/UPDATES.md` (the tree carries `cli/`).
- `TECH-STACK.md` (Go, for the CLI alone), `ARCHITECTURE.md` (the CLI as a second
  program, `cli/`), `CODING-RULES.md` §12 (the Go rules), `AGENTS.md` (the commands
  line: the check needs Go).

The builder edits none of these. It reports each sentence its work makes untrue, with
file and line. `README.md` and `CHANGELOG.md` are the builder's.

**The one exception: `specs/ERROR-HANDLING.md`.** These rows, agreed here, are added by
the builder in the commit that first throws each code:

| Code | Status | Meaning |
|------|--------|---------|
| `CLI_VERSION_MISMATCH` | 409 | The `wisp` CLI that sent the request is of another version than this Wisp |
| `CLI_NOT_AVAILABLE` | 404 | This Wisp carries no CLI binary for the platform asked for |

## Decisions

- **Go, standard library only**, in `cli/` with its own module. It shares no code with
  the backend: the API is the boundary.
- **The server checks the version**, from a header the CLI sends: no extra request, and
  nothing is half done when the two differ. Exact match, no compatibility range.
- **Built where a release is staged.** `scripts/stage-release.sh` builds the binaries,
  so the release workflow and `push.sh` both ship them, stamped with the version in the
  root `package.json`. Go is needed there and for `npm run check`; no `Makefile`.
- **The download is public**; the token never is a command's argument.
- **The hidden token prompt** uses the system's own terminal calls, in build-tagged
  files per platform, rather than a package.

## Verification

- Go unit tests for the CLI's logic, and one end-to-end test that runs the built binary
  against a fake Wisp (`net/http/httptest`).
- The server's routes and the header's check: the backend's unit tests.
- Against a real Wisp on tini (`CODING-RULES.md` §14), read-only but for the tokens the
  builder makes there, which it revokes. Installs go into a throwaway home folder, never
  the user's own.
- **Windows is tried by the user.** Neither the development machine nor tini runs a
  Windows program. The builder compiles the Windows binaries, tests what is shared, and
  lists in its report what only a Windows machine can show: the install line, the config
  file's place, the hidden token prompt, and `wisp update` replacing a running program.
  The user runs that list before the merge.

## Milestones

### 1. A CLI that Wisp builds, serves and answers

- `scripts/stage-release.sh` puts a `wisp` binary for each platform in `CLI.md` into
  the staged tree, each printing the root `package.json`'s version for `wisp version`;
  the staged tree's own check knows them.
- On tini after a `push.sh` deploy, `GET /api/cli` answers the version and the
  platforms, with no credentials.
- There, `curl -fsSL <url>/api/cli/install.sh | sh` under a throwaway home installs a
  binary that runs; the same on the Mac, for its platform.
- With `WISP_URL` and `WISP_TOKEN` set, `wisp containers list` prints tini's containers
  as a table, and with `--json` the JSON `GET /api/containers` sends.
- With neither a profile nor the environment, it says to run `wisp login` and exits `1`;
  an unknown command exits `2` and sends nothing.
- A development checkout answers `GET /api/cli` with no platforms, and a download with
  **404** `CLI_NOT_AVAILABLE`.
- `npm run check` runs the Go checks (format, vet, staticcheck, tests) and says what is
  missing when Go is not installed.
- The end-to-end test runs the built binary against a fake Wisp.

### 2. Signing in, with profiles

- `wisp login <url>` asks for the token without showing it, checks it against the
  server, and writes the profile `default` to the config file, mode `0600`; with the
  token on standard input it asks nothing.
- A wrong token, or an address that is not a Wisp, saves nothing and says why.
- `wisp --profile tini login <url>` adds a second profile; `wisp profiles` lists both
  with the default marked and no token; `wisp --profile tini default` changes the
  default; `wisp --profile tini logout` removes it.
- `--profile` wins over `WISP_URL` and `WISP_TOKEN`, which win over the default profile.
- The token appears in no command line and no output of any command.

### 3. The version check, and `wisp update`

- A request with a `Wisp-Cli-Version` other than the server's answers **409**
  `CLI_VERSION_MISMATCH` naming both, before the route's handler; one without the
  header is served as before.
- A CLI of another version, against tini, prints the two versions and the words
  `wisp update`, and exits `1`.
- `wisp update` then replaces the binary with tini's, and the same command works.
- A download that fails leaves the old binary in place and working.
- `wisp version` prints both versions.

### 4. The commands that read, and how the CLI is found

- `containers show` prints a container's settings, env, mounts and, for an app
  container, the app's config; `images list` and `jobs list` print their lists. Each
  prints text, and with `--json` the API's JSON; a secret env value is masked in both.
- `containers logs <name>` prints the newest run's last lines and ends; `--lines` and
  `--run` choose; `--follow` prints new lines until interrupted.
- `jobs wait <id>` prints a running job's progress and ends with its result or its
  error, exit `0` or `1`.
- An API refusal is printed as its code and message, exit `1`.
- `wisp help` lists every command of `CLI.md` that this feature builds, and
  `wisp help <command>` each of its flags; neither says who `--json` is for.
- **Host → App Config → API tokens** shows the install line for the address in use,
  with a copy action.
- MCP's `initialize` instructions say the CLI exists and where its install line is.
