# The `wisp` CLI

`wisp` is a command-line client of Wisp's REST API, for coding agents and for the user at
a terminal: one static binary with nothing to install beside it. The server-side tool
that manages an install, `wispctl`, is another program ([DEPLOYMENT.md](DEPLOYMENT.md)).

## Principles

- **A client of the REST API, and nothing else.** Every command is one or a few requests
  any HTTP client could send with the same token. The CLI holds no rule of its own about
  what is allowed: the token's scope decides ([AUTH.md](AUTH.md#the-agent-scope)), and a
  refusal is the server's, printed as it came.
- **Served by the Wisp it talks to.** A Wisp carries the CLI of its own version, for
  every platform, so installing and updating need no internet and the two always match.
- **One version on both sides.** A CLI and a Wisp of different versions do not talk
  ([Version check](#version-check)).
- **A command answers a whole question, and the server does the joining.** The commands
  are made to be useful, not to mirror the API route by route: `vms show` prints a VM
  with its address, `overview` the whole host. What a command prints is one answer of
  the API, so where a question needs facts from several places the API has a read that
  joins them. The CLI assembles no picture of its own: `--json` is the server's answer,
  and any other client gets the same.
- **No dependencies.** Go's standard library only ([TECH-STACK.md](../TECH-STACK.md)).

## Getting it

Wisp serves the CLI from its own install, to anyone who can reach it: the files hold no
secret and are the same on every Wisp of that version.

| Route | Level | Answers |
|-------|-------|---------|
| `GET /api/cli` | `public` | `{ version, platforms }`: Wisp's version, and the platforms it has a binary for |
| `GET /api/cli/wisp-<platform>` | `public` | The binary, as a download. An unknown platform, or a Wisp that carries none (a development checkout), is **404** `CLI_NOT_AVAILABLE` |
| `GET /api/cli/install.sh` | `public` | The install script for macOS and Linux |
| `GET /api/cli/install.ps1` | `public` | The install script for Windows |

- **Platforms:** `darwin-arm64`, `darwin-amd64`, `linux-arm64`, `linux-amd64`,
  `windows-arm64`, `windows-amd64`.
- **Installing** is one line, shown with a copy action in **Host → App Config → API
  tokens** ([UI-HOST.md](UI-HOST.md)): `curl -fsSL <url>/api/cli/install.sh | sh`, or
  `irm <url>/api/cli/install.ps1 | iex` on Windows. `<url>` is the advertised URL when
  one is set ([SETTINGS.md](SETTINGS.md)), else the address the request came to.
- **The script** picks the platform, downloads that binary from the Wisp that served the
  script, and puts it in the user's own programs folder (`~/.local/bin/wisp`;
  `%LocalAppData%\Programs\wisp\wisp.exe`), with no root. It says so when that folder is
  not on the `PATH`, and ends by naming the next command, `wisp login`.

## Signing in

The CLI needs two things: a Wisp's address and an API token
([AUTH.md](AUTH.md#api-tokens)). It takes them from a profile, or from the environment.

### Profiles

A profile is a name for one Wisp: its `url` and a `token`. They live in one file the CLI
writes, `config.json` in the user's configuration folder (`$XDG_CONFIG_HOME/wisp/`, by
default `~/.config/wisp/`; `%AppData%\wisp\` on Windows), mode `0600` in a `0700`
folder:

```json
{
  "version": 1,
  "default": "home",
  "profiles": {
    "home": { "url": "https://wisp.home.example.com", "token": "wisp_agent_…" },
    "tini": { "url": "http://tini.local:8080", "token": "wisp_agent_…" }
  }
}
```

| Command | Does |
|---------|------|
| `wisp [--profile <name>] login <url>` | Checks that the address is a Wisp before any token is sent to it. Asks for the token, with the typing hidden, or reads it from standard input when that is not a terminal, waiting 10 s for it. Checks the address and the token against the server, then saves the profile. Without `--profile` the profile is named `default`. The first profile saved becomes the default one. |
| `wisp --profile <name> default` | Makes that profile the default. |
| `wisp profiles` | Lists the profiles: name, address, the token's scope, and which is the default. Never a token. |
| `wisp [--profile <name>] logout` | Removes the profile. The token stays valid on the server until it is revoked there. |

- **The token is never a command's argument**, so it stays out of the shell's history
  and the process list.
- **`--profile <name>`** goes before the command and picks the profile for that one
  call.

### The environment

`WISP_URL` and `WISP_TOKEN`, set together, are enough with no file at all: for an
agent's sandbox, or CI. One without the other is an error, never a fall back to a
profile.

**Which one is used**, first match: `--profile`; `WISP_URL` with `WISP_TOKEN`; the
default profile. With none, the CLI says to run `wisp login`.

### Transport

- An `https` address is checked against the system's certificate authorities. An `http`
  address is taken as it is, for the LAN.
- **No redirect is followed.** Wisp's API sends none, so an answer that redirects is
  not a Wisp, and the token never follows one to another address.
- Every request carries `Authorization: Bearer <token>`. Nothing else leaves the
  profile.

## Version check

- The CLI sends its version with every request, in the `Wisp-Cli-Version` header.
- A Wisp of another version refuses the request before anything runs: **409**
  `CLI_VERSION_MISMATCH`, the `detail` naming both versions. A request without the
  header is not checked: other clients send none.
- The CLI then says to run **`wisp update`**, which downloads the binary for this
  platform from the profile's Wisp, runs it to check that it is the CLI of that Wisp's
  version, and replaces itself with it. The old binary stays in place when the download
  fails or is anything else.
- **The check comes after the token's**, so a refusal for the version means the token
  was accepted. `wisp login` against a Wisp of another version therefore saves the
  profile and says to run `wisp update`: a CLI can always sign in to fetch the right
  binary.
- **`wisp version`** prints the CLI's version and the Wisp's (`GET /api/cli`).
- Two Wisps on two versions take a `wisp update` when switching between them.

## Commands

`wisp help` prints every command with a line each; `wisp help <command>` and `--help`
print one command in full, with an example. The help is what an agent learns the CLI
from, so it is complete: no command, flag or argument exists outside it.

| Group | Commands |
|-------|----------|
| The CLI itself | `login`, `logout`, `profiles`, `default`, `version`, `update`, `help` |
| The whole host | `overview` |
| `containers` | `list`, `show`, `create`, `set`, `update`, `start`, `stop`, `restart`, `logs`, `upload`, `usage` |
| `images` | `list`, `push`, `check` |
| `vms` | `list`, `show` |
| `host` | `stats`, `hardware` |
| `jobs` | `list`, `wait` |

**VMs and the host are read, never changed.** No command creates, starts, stops or edits
a VM, or changes the host: none of that is an `agent` token's to do.

**`wisp overview` is where to start**: one call that maps the host, every container and
every VM, with the address each one answers at.

**One command reads a container and one changes it.** `containers show` prints
everything about a container: its settings, env, mounts and, for an app container, the
app's config. `containers create` and `containers set` take every setting as a flag,
env and mounts among them. There is no command group per part of a container.

### What each does

| Command | Request | Notes |
|---------|---------|-------|
| `overview` | `GET /api/overview` | Wisp's version, the host, its bridges, the certificate's domain, and every container and VM with its state and address |
| `containers list` | `GET /api/containers` | |
| `containers show <name>` | `GET /api/containers/:name` | Secrets masked, as the API sends them |
| `containers create <name> --image <ref> [settings]` | `POST /api/containers/deploy` | Creates a generic container with the [settings](#the-settings-flags) given, mounts included, and starts it: one job. `--no-start` leaves it stopped, for files to be uploaded first |
| `containers set <name> [settings]` | `PATCH /api/containers/:name`; `POST …/mounts` per mount added | Changes the settings given, and leaves the rest |
| `containers update <name> [--image <ref>]` | `POST /api/containers/:name/image-update` | Pulls the image again, or moves to another, and restarts a running container |
| `containers start` / `stop` / `restart <name>` | the lifecycle routes | |
| `containers logs <name>` | `GET /api/containers/:name/logs` | The newest run's last lines (`--lines`, default 100), then ends; `--follow` keeps printing new lines; `--run <id>` picks a run |
| `containers upload <name> <mount> <path>` | `POST …/mounts/:mountName/file` or `…/zip`; for a file, `GET /api/containers/:name` first | A file goes to a file mount. A zip or a folder goes to a folder mount and **replaces its content**. A file is sent by the mount's kind, which the CLI reads first. A folder is zipped by the CLI as it is sent: a link to a file is sent as that file, a link to anything else is refused, and so is a folder with nothing in it |
| `containers usage <name>` | `GET /api/containers/:name/mounts/usage` | The size on disk of each mount's data. Can take seconds on a large folder |
| `images list` | `GET /api/containers/images` | |
| `images push <archive>` | `POST /api/containers/images/upload` | An archive file, or `-` for standard input (`docker save myapp:v1 \| wisp images push -`). Prints the `localhost/` name each image is stored under |
| `images check` | `POST /api/containers/images/check-updates` | Checks every image for a newer one, as one job. Prints how many images were checked, how many have a newer one and how many containers run an older one; `overview` then shows which |
| `vms list` | `GET /api/vms` | |
| `vms show <name>` | `GET /api/vms/:name` | The VM's state and settings (CPU, memory, firmware, disks, network cards) and, while it runs, how long it has been up and the guest's name and address |
| `host stats` | `GET /api/host/stats` | One sample of the host's live figures: CPU, temperatures, memory, disk and network rates, pending updates |
| `host hardware` | `GET /api/host/hardware` | The hardware: CPU, board, memory modules, disks with their health, PCI devices, GPUs |
| `jobs list` | `GET /api/jobs` | |
| `jobs wait <id>` | `GET /api/jobs/:jobId/progress` | |

### The settings flags

For `containers create` and `containers set`. Each may be given once, but for those that
say otherwise.

| Flag | Sets |
|------|------|
| `--image <ref>` | The image. Required by `create` |
| `--env KEY=VALUE` | An env variable; may be repeated |
| `--secret-env KEY=VALUE` | An env variable stored write-only; may be repeated |
| `--unset-env KEY` | Removes an env variable; may be repeated. `set` only |
| `--mount <name>:<container-path>[:ro]` | Adds a folder kept on this host; may be repeated |
| `--file-mount <name>:<container-path>[:ro][:secret]` | Adds a file kept on this host; may be repeated |
| `--tmpfs <name>:<container-path>[:<MiB>]` | Adds a memory folder; may be repeated |
| `--cpu <cores>`, `--memory <MiB>` | The limits; `none` removes one |
| `--restart-policy <policy>` | `never`, `on-failure`, `unless-stopped` or `always` |
| `--autostart on\|off`, `--auto-backup on\|off`, `--local-dns on\|off` | Start at boot, the scheduled backup, Local DNS |
| `-- <command> [args…]` | The command the container runs: everything after `--`. `--no-command` goes back to the image's own. |
| `--app-config <file>` | An app container's config: the fields to change, as JSON in a file or `-` for standard input. `set` only, and with no other setting, as the server saves an app's config alone |

- **`set` adds mounts and never removes or edits one**: a name that exists is the
  server's refusal. Removing a mount is not an `agent` token's to do.
- **`set` may send more than one request**: the settings and env as one, then each mount
  added. The first that fails ends the command, which says what was saved before it.
- `create` sends one request whatever it carries.

### Behaviour every command shares

- **Flags and arguments** may come in either order.
- **Output:** text by default, laid out for reading: a table for a list, labelled lines
  for one thing. On a command that prints what the API sent, `--json` prints the API's
  own JSON instead, unchanged, for a script to parse: a job's command prints the job's
  result, or the job's ack with `--no-wait`. A command with no JSON to print takes no
  `--json`: `containers set` and `containers logs` among them. What a command prints
  is on standard output; progress and errors are on standard error.
- **A command that starts a job waits for it**, printing the job's progress as it
  comes, and ends when the job does: with its result, or with its error. `--no-wait`
  prints the job's id and ends at once. An interrupt (Ctrl-C) ends the wait, never the
  job, and says so.
- **An error** is one line: the API's code and its message (`CONTAINER_BUSY: …`). With
  `--json` it is the error body.
- **Exit codes:** `0` done; `1` the request or the job failed; `2` the command line was
  wrong, and nothing was sent.
- **Nothing waits forever:** a request that gets no answer, and a stream or an upload
  that stops moving, end with an error after a bound.

## Not supported

- Changing a VM or the host, deletes and whatever else an `agent` token cannot do. An
  `admin` token widens what the same commands may touch, not the list of commands.
- A token stored anywhere but the profile file or the environment (no keychain).
- Talking to a Wisp of another version.
