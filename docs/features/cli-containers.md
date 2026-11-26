# Containers from the CLI

Agreed with the user on 2026-11-26, as the fifth step of making Wisp work out of the
box. It follows "The CLI, installed and signed in".

## What it is for

The CLI reads. With this feature it builds, runs and updates containers: everything an
`agent` token may do that an agent needs to ship its own image and expose it, from a
shell, with no MCP client and no knowledge of the API.

## The specs it changes

Written by the design session with this file, and agreed with it:

- `specs/CLI.md`: the commands `containers create | set | update | start | stop |
  restart | upload` and `images push`, the settings flags, and how a command waits for
  its job.
- `specs/API-CONTAINERS.md`: two routes, `POST /api/containers/deploy` and
  `POST /api/containers/:name/image-update`. Each is one job the server already has,
  which so far only an MCP tool could start.
- `specs/MCP.md`: `deploy_container` gains `command` and `start`, as the route has them.
- `specs/AUTH.md`: the two routes among the `agent` ones.

The builder edits none of these. It reports each sentence its work makes untrue, with
file and line. `README.md` and `CHANGELOG.md` are the builder's.

## Decisions

- **One operation, two doors.** Wisp has two ways in for a caller that is not the
  page: the REST API and the MCP endpoint. The CLI uses the REST API only. The deploy
  and the image update each exist as one function on the server, reached only through
  an MCP tool so far; the two routes are the REST API's way to the same functions.
- **The CLI composes nothing the server can do in one job.** `create` is the deploy
  route, mounts included, not a create, a settings change, mounts and a start sent one
  after the other.
- **One command reads a container and one changes it.** Env, mounts and an app's config
  are flags of `create` and `set`, shown by `show`: no command group per part.
- **The deploy route takes mounts; MCP's tool does not.** MCP exposes no mounts.
- **A folder is zipped by the CLI as it is sent**, with the standard library, so an
  agent ships a build folder with one command and no `zip` installed.

## Verification

- Go unit tests, and the end-to-end test's fake Wisp, for each command's request.
- The two routes: the backend's unit tests for what is decided before a manager is
  called.
- On tini (`CODING-RULES.md` §14), with an `agent` token and throwaway containers and
  images only, removed when the builder is done.

## Milestones

### 1. Create a container and run it

- `POST /api/containers/deploy` with an `agent` token creates, sets up and starts a
  container as one job, whose result is the new container; the MCP tool
  `deploy_container` answers the same for the same input.
- On tini, `wisp containers create <name> --image <ref>` with env, a secret env, a
  command and limits prints the job's progress, ends when the container runs, and
  `wisp containers show` shows the settings, the secret masked.
- `--no-start` leaves it defined and stopped.
- `wisp containers stop`, `start` and `restart` each wait for their job and end `0`; on
  a container that is busy or already in that state they print the API's refusal and
  end `1`.
- `--no-wait` prints the job's id at once, and `wisp jobs wait` on it ends as the
  command would have.
- An interrupt during a wait ends the command, says the job goes on, and the job does.

### 2. Change it and update it

- `wisp containers set <name>` changes each setting it has a flag for, and
  `containers show` shows it; a setting an `agent` token may not send is refused by the
  server, and the CLI prints that refusal.
- `--env A=1 --env B=2` and `--unset-env A` change the env; `--secret-env` stores a
  value that no later command prints.
- `-- <command> [args…]` sets the command, and `--no-command` goes back to the image's.
- `POST /api/containers/:name/image-update` with an `agent` token pulls, repoints and
  restarts as one job; the MCP tool `update_container_image` answers the same.
- On tini, `wisp containers update <name>` re-reads the image and restarts a running
  container; `--image <ref>` moves it to another image.

### 3. Give it files, and expose it

- `POST /api/containers/deploy` with `mounts` makes them before the start; from an
  `agent` token a mount with `sourceId` or `subPath` answers **403**
  `SCOPE_INSUFFICIENT`.
- On tini, `wisp containers create <name> --image <ref> --mount site:/srv --no-start`
  makes the container with its folder mount in one job; `--file-mount` and `--tmpfs`
  make the other kinds.
- `wisp containers set <name> --mount data:/data` adds a mount to a container that
  exists; a name that exists prints the server's refusal; with a setting and a mount
  whose add fails, the command says the setting was saved.
- `wisp containers upload` sends a file to a file mount, a zip to a folder mount, and a
  folder to a folder mount: on tini the container then serves the folder's files, and
  what the mount held before is gone.
- A folder with nested folders, an empty folder and a file over 100 MB each arrive as
  they were.
- `wisp containers set <caddy> --app-config <file>` with `{ "hosts": [...] }` changes a
  throwaway Caddy app's sites, and `containers show` shows them; a field outside the
  app's writable ones prints the server's refusal; `--app-config` with another setting
  exits `2` and sends nothing.

### 4. Push an image

- On tini, `wisp images push <archive>` uploads the archive, waits for the import and
  prints `localhost/<name>`; `wisp images list` shows it.
- `docker save <image> | wisp images push -` does the same from standard input.
- An archive for another architecture prints the import's error and ends `1`.
- A container created with the printed name runs: the whole path, build elsewhere,
  push, create, with no registry.
