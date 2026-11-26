# The `agent` token scope

Agreed with the user on 2026-11-26, as the second step of making Wisp work out of the
box. Image upload and the `wisp` CLI follow it, each a feature of its own.

## What it is for

An API token is `read` or `admin` today. A coding agent that deploys a container needs
`admin`, and `admin` also deletes containers, changes VMs, edits the host's settings and
powers the host off.

With this feature a token has a third scope, `agent`, between the two: it builds, runs
and updates containers, and cannot delete, cannot give a container more reach into the
host, and cannot change a VM or the host. The token form preselects it.

## The specs it changes

Written by the design session with this file, and agreed with it:

- `specs/AUTH.md`: the `agent` route level, the three scopes, the section "The `agent`
  scope" (what it may do, what stays `admin`, narrowed requests, what the scope does not
  promise).
- `specs/API-CONTAINERS.md`: the entries tagged `agent`, and each entry's *An `agent`
  token:* line. `specs/API-BACKUPS.md`: a container's backup is `agent`.
- `specs/API.md` (the levels table, the MCP entry), `specs/API-AUTH.md` (the scope's
  values), `specs/ERROR-HANDLING.md` (what `SCOPE_INSUFFICIENT` means),
  `specs/CONFIGURATION.md` (`apiTokens[].scope`).
- `specs/MCP.md`: the mutating tools ask for `agent`.
- `specs/CUSTOM-APPS.md`: the agent-writable fields also bound a `PATCH` from an `agent`
  token.
- `specs/UI-HOST.md`: the token form's three scopes. `TECH-STACK.md`: the Auth line.

The builder edits none of these. It reports each sentence its work makes untrue, with
file and line. `README.md` (its lines on API tokens and agent deploys) and
`CHANGELOG.md` are the builder's.

## Decisions

- **Three scopes in one order**, `read` < `agent` < `admin`; a route has one level and
  the hook compares the two. No per-token list of permissions.
- **No new error code.** A scope refusal is `SCOPE_INSUFFICIENT` wherever it is made.
- **No migration.** The stored token record keeps its shape; `scope` gains a value.
  Tokens made before keep their scope.
- **Narrowing has two homes, and no third.** The body keys a route refuses from an
  `agent` token are declared in the route's options and enforced by one hook. A refusal
  that depends on what is stored is made by the container operation, which is told the
  caller's scope. A route handler tests no scope itself.
- **One rule for agent-writable app config.** The MCP tool and the `PATCH` from an
  `agent` token use the same code to pick the writable keys and merge them onto the
  stored config. Each names its own refusal: the tool refuses every caller
  (`APP_CONFIG_ONLY`, as today), the `PATCH` refuses the scope (`SCOPE_INSUFFICIENT`).
- **MCP's tool list does not grow.** The fuller agent surface is the REST API's, for the
  CLI.

## Verification

- Unit tests where the answer is decided before a manager is called: the hook, the
  narrowing, the token routes, the config's strict read, the MCP layer.
- Manager paths on tini (`CODING-RULES.md` §14), with throwaway containers only. The
  tokens the builder makes there are revoked when it is done.

## Milestones

### 1. An `agent` token, and the routes that take it

A token can be made with the scope `agent`, and it is let through exactly where the
specs say.

- `POST /api/auth/tokens` with `scope: "agent"` answers 201 with a token that starts
  `wisp_agent_`; the list shows it with scope `agent`; another scope value is 400
  `VALIDATION_FAILED`.
- A `wisp-config.json` that holds an `agent` token passes the strict read at the start;
  one with a scope outside the three still stops it, naming the key.
- For a route of each level (`read`, `agent`, `admin`, `session`, `mcp`), a `read`, an
  `agent` and an `admin` token and a session each get the answer `AUTH.md` gives: let
  through, **403** `SCOPE_INSUFFICIENT`, or **403** `SESSION_REQUIRED`.
- `npm run route-access` shows as `agent` the 18 routes the API files tag `agent`
  (17 in `API-CONTAINERS.md`, one in `API-BACKUPS.md`) and no other.
- The token form opens with **Agent** chosen, shows the three scopes each with its line,
  and a token made with it is listed with its scope.
- On tini, with an `agent` token and a throwaway container: create, an env edit, start,
  adding a folder mount, a zip upload into it, writing then reading a file mount's
  content, adding a service, a backup, stop. Each answers as it does for an `admin`
  token.
- On tini, with the same token: deleting the container, deleting a mount, deleting a
  mount's data, eject, restoring a backup, deleting an image, starting a VM and a
  settings `PATCH` each answer **403** `SCOPE_INSUFFICIENT`, and nothing changed.

### 2. Narrowed requests

An `agent` route refuses from an `agent` token the part that stays `admin`.

- Each body key an entry lists under *An `agent` token:* answers **403**
  `SCOPE_INSUFFICIENT` with the key in the `detail`, and nothing is written: on create
  `app`, `appConfig`; on `PATCH` `name`, `runAsRoot`, `network`, `devices`, `mounts`,
  `mountRenames`; on a mount's add and edit `sourceId`, `subPath`.
- The same requests from an `admin` token and from a session pass the check.
- A body that breaks its schema and carries a refused key answers **400**
  `VALIDATION_FAILED`.
- `npm run route-access` prints, for each narrowed route, the keys it refuses from an
  `agent` token.
- An edit or an `init` of a mount that has a `sourceId` answers **403**
  `SCOPE_INSUFFICIENT` to an `agent` token, and the mount is unchanged.
- On tini, a throwaway Caddy app container: a `PATCH` `{ appConfig: { hosts } }` from an
  `agent` token saves the sites, keeps the rest of the stored config and reloads; a key
  outside the app's writable ones answers **403** `SCOPE_INSUFFICIENT` naming it.
- An app with no agent-writable key answers **403** `SCOPE_INSUFFICIENT` to an `agent`
  token's `appConfig`; a generic container still answers **422** `CONFIG_ERROR`.

### 3. The MCP tools take an `agent` token

- `tools/list` shows a `read` token the read tools only, and an `agent` and an `admin`
  token every tool.
- `tools/call` on a mutating tool answers a `read` token with `SCOPE_INSUFFICIENT`, and
  runs for an `agent` token.
- On tini, `start_container` and `stop_container` on a throwaway container with an
  `agent` token each return a job that ends `done`.
