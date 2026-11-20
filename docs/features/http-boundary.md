# The HTTP boundary: errors, jobs, schemas

Phase 3 of `docs/reviews/2026-11-17/IMPLEMENTATION.md`. Findings R-1 to R-6, R-8 to R-10,
X-7, D-3, D-4 and D-6 of that folder's `AUDIT.md`. Built to the plan's ground rule 1: what
a build from scratch would have.

## What it is for

A new command today has about twelve places to touch, and six of them fail silently when
missed. Errors are answered four ways, jobs are started two ways and followed four ways,
and a third of the routes validate nothing. This feature gives the boundary one way to do
each: one error path, one job mechanism, a schema on every route, and the follow-ups of an
operation written once, where a route, an MCP tool and the scheduler all reach them.

The wire changes were settled on 2026-11-18 (the plan, Decisions): the error body, one job
progress route, `POST` for the package refresh, unknown keys refused. This feature says
what each becomes.

## Decisions

### Errors

- **One body on every channel**: `{ error, detail }`. `error` is the stable code and is
  always there. `detail` is the human-readable message. This is CODING-RULES §5 as
  written; today `error` carries the message. There is no separate `code` key.
- **Every channel** means HTTP answers, error frames on the event stream, a job's `error`
  event (`{ step: "error", error, detail }`) and MCP tool errors.
- **Every answer has a code**, the framework's included: a request that fails its schema,
  an unknown route, a missing or expired session, a body that is too large.
- **Routes throw, one handler answers.** No route builds an error body or picks a status.
  One table maps a code to its status. `handleRouteError`, `sendError` and the raw
  `reply.code(…).send(…)` error answers go.
- **Redaction in that one place**, so it covers every channel: paths and UUIDs are
  replaced in `detail` on HTTP, on job events, on stream frames and in MCP answers. Today
  only two of the four HTTP ways redact, and no other channel does.
- **Every code is documented.** `ERROR-HANDLING.md` lists each code with its status and
  meaning. `npm run check` fails when the code throws a code the table lacks, or the table
  holds one the doc lacks.
- **The client has one error object and one way to show it**: `status`, `code`, `detail`,
  and an `errorText(err)` helper that every component uses. A lost session is recognised
  by its code, not by the string "Session expired".

### Jobs

- **One store, one starter.** Every job is started by the same function, which logs it,
  runs it and ends it. The eleven hand-written sites are converted. Job ids have one form.
- **A job says what it acts on.** A job on a VM or a container carries a `subject`
  (`{ type, name }`). Such a job holds that workload's operation lock from its start to
  its end: the starter takes the lock, answers the busy error at once when it is held, and
  releases it when the job ends. The scheduler's backup uses the same starter.
- **Busy is read from the subject.** A workload is busy while a running job has it as its
  subject. No code compares a job's title, on the server or in the client.
- **Two routes**: `GET /api/jobs` lists them (it replaces `/api/background-jobs`), and
  `GET /api/jobs/:jobId/progress` is the one progress stream. The six per-feature progress
  routes go, with no aliases.
- **One event shape.** Progress events keep `step`, with `percent` and `detail` where they
  apply. The last event is `{ step: "done", result }` or the error event above. The result
  is its own key, no longer spread into the event.
- **One kind per operation.** The image update check is one kind, whether started from the
  UI or through MCP.
- **Every job is in the tray and readable through MCP**: `get_job` reads the one store.
- **`POST /api/host/updates/check` starts the package check**, as it does today, and is
  the one route that does (settled 2026-11-20: the feature first named a second route,
  `…/packages/refresh`, for what this one already did). `GET /api/host/updates/packages`
  only reads what the last check found, with `checkedAt` (`null` before any check). A
  read token can no longer start a job.
- **The client follows a job one way**: `awaitJob`. A component that shows a job's
  progress reads that job's row from the store. `registerJob` with callbacks and the raw
  subscriptions go.

### Operations and their follow-ups

- **An operation's follow-ups are written once**, outside the routes, and a route, an MCP
  tool and the scheduler call the same function: backup (manual, scheduled, and the safety
  backup before a restore in place), rename, delete, and a configuration update.
- **VMs and containers get the same follow-ups.**
  - Rename: the sidebar section assignment, the backup status and the `.local` name move
    to the new name.
  - Delete: the `.local` name is withdrawn, and the backup status and the section
    assignment are removed.
  Today the VM side does none of these but one, and neither side removes the section
  assignment.
- **The lock is taken in one place per kind of command**: by the job starter for a job,
  and by one wrapper for an instant command. No route takes a lock itself.
- **One rule for VMs and containers** (settled 2026-11-20): every command that changes a
  workload's state, definition, config or files takes its lock, for the call or for the
  whole job. A job that creates a workload holds the lock of the name it creates. This
  ends the exemptions settled on 2026-10-16 (a VM's stop, force-stop, reboot, suspend and
  resume; create and restore as new; a container's mount content commands). A VM's stop
  holds the lock only while the request is sent: a force-stop stays possible while a
  shutdown is pending.

### Schemas

- **Every route declares its schemas**: params, querystring and body where it has them,
  and a response schema for each success it answers. Errors use the one error schema.
- **Unknown keys are refused** with 400, naming the key, in bodies and in querystrings.
  Today they are silently dropped. JSON bodies are not coerced (a string is not a number);
  querystrings and params, which arrive as strings, are.
- **One declaration form** for every route, and one module for the schemas more than one
  route file uses (the job ack, the error body, a workload name).
- **MCP tool arguments are validated** against each tool's own input schema, unknown keys
  refused, with the same error shape. `ajv` becomes a direct dependency of the backend
  for it, at the major version Fastify uses (agreed 2026-11-20).
- **A route without its schemas fails `npm run check`**, through the route report that
  already checks each route's access level.
- **`routes/containers.js` and `routes/library.js` are rewritten** to this standard, and
  the library's file reads move into its lib.

### Outbound requests

- `lib/downloads` is the one home for outbound requests, with two fetches (settled
  2026-11-20). One is for URLs that come from user input and refuses private and loopback
  addresses: the GitHub keys for cloud-init use it. The other is for an endpoint only the
  operator sets, the OIDC issuer, and allows them, so an identity provider on the LAN
  keeps working. `npm run check` fails a `fetch` or an `undici` import anywhere else in
  the backend.

## What it changes in the docs

- `specs/ERROR-HANDLING.md`: rewritten around the one body, the one table and the
  channels.
- `specs/API.md`: the error body, Background jobs, Job routes.
- `specs/API-VMS.md`, `API-CONTAINERS.md`, `API-BACKUPS.md`, `API-LIBRARY.md`,
  `API-HOST.md`: the progress routes removed, the package check, and each route's
  answer where a response schema changes it.
- `specs/BACKUPS.md`: Progress Tracking and the operation lock's "the frontend mirrors
  it" passage. `specs/MCP.md`: `get_job`, tool errors, argument validation.
- `FRONTEND-RULES.md`, Workload busy. `CODING-RULES.md` §5 and §9, the "Applied" lines.
  `TECH-STACK.md`, the server's validation and error lines. `ARCHITECTURE.md`, where the
  operations with their follow-ups live.
- `BACKLOG.md`, removed: "Six job progress streams", "MCP's `get_job` reads only the
  operation job store", "A GET that starts a job", "Route errors carry the message, not a
  stable code", "`PATCH /api/containers/:name` has no body schema", "Deleting a VM leaves
  its `backup-status.json` entry", "A VM rename doesn't move its sidebar section". The
  builder says for each other entry about jobs or errors whether this work closes it.

## Constraints

- No aliases and no second shape kept for old clients. The UI ships with the backend. The
  changelog of the release that carries this names every changed route and body, for
  scripts that use an API token and for MCP clients.
- A page left open from the previous release must still get through the update: it polls
  `GET /api/host` and reloads.
- A response schema drops any field it does not list. Each route's answer is compared
  before and after on the test host.
- The boundary's own behaviour (error answers, schema refusals, the job store and its
  starter) gets unit tests that build the app on the stub managers. Manager paths stay
  verified on the test host (CODING-RULES §14).
- Each milestone leaves the app working end to end: the client changes of a milestone
  land with its server changes.

## Milestones

### 1. Errors, one path

Acceptance, on the test host unless said otherwise:

- A missing VM answers 404 `{ "error": "VM_NOT_FOUND", "detail": … }`. A body that fails
  its schema, an unknown route and a request without a session each answer with a code.
- A failed job's stream ends with `{ "step": "error", "error": <code>, "detail": … }`, and
  an MCP tool error has the same two keys.
- An error whose detail holds a path shows `<path>` on HTTP, on a job's stream and in an
  MCP answer.
- In the UI: a route error, a job error and an expired session each show their text, and
  the expired session returns to the login page.
- No route file calls `handleRouteError` or `sendError`, or sends an error body itself.
- `npm run check` fails with a thrown code missing from the table, and with a table code
  missing from `ERROR-HANDLING.md` (each shown once, then put back).

### 2. Jobs, one mechanism

- Each job kind, started once, is listed by `GET /api/jobs`, streams to its last event on
  `GET /api/jobs/:jobId/progress`, and is returned by MCP's `get_job`. The old progress
  routes and `/api/background-jobs` answer 404.
- While a VM backup runs: the VM page's changing controls are disabled, those of a
  container with the same name are not, and a start sent with `curl` answers 409 with the
  busy code. After a page reload the tray shows the job with its progress.
- `GET /api/host/updates/packages` with a read token starts no job.
  `POST /api/host/updates/check` starts one.
- No job is created outside the starter, and the client has no `registerJob` callback, no
  raw progress subscription and no comparison of a job's title.

### 3. Operations and their follow-ups

- A VM that is in a sidebar section, has a backup status and a `.local` name is renamed:
  the section keeps it, the backup status is under the new name, the new name resolves and
  the old one does not. Deleted: its backup status and section assignment are gone and
  the name no longer resolves. The same for a container.
- A container deployed through MCP with local DNS on resolves by its `.local` name.
- A scheduled backup, a manual one and a restore in place each run through the one
  orchestration, and each records its attempt.
- No route file calls the lock functions.

### 4. Schemas on every route

- `npm run check` passes, and fails when a schema is taken off one route (shown once).
- For every `GET` route, the answer of the build before this milestone and of the build
  after it are the same JSON. Each difference is listed and explained.
- For each command route: one valid call works, and one with an unknown key answers 400
  naming the key.
- Each page of the UI loads and each of its sections saves.
- An MCP tool called with an unknown argument answers the error shape.

### 5. Outbound requests

- Importing GitHub keys for a VM's cloud-init works.
- `npm run check` fails with a `fetch` call added outside `lib/downloads` (shown once).
- The builder says what of the OIDC path could be run.

## Not in this feature

- Splitting the managers and the "strict manager" rule (phase 5).
- The stores' races and the shared VM and container store code (phase 4).
- The error banner with a dismiss, and the other shared components (phase 6).
- Jobs that survive a restart of the backend.
