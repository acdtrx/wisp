# Coding Rules

Generic principles for how code is written, tested and debugged, for any contributor
(human or coding agent) working on this codebase. They are project-independent, except §12
(`[PROJECT]`), the project's language rules.

Specialize a rule for the project by weaving its concrete instance inline ("Applied: …")
under the matching principle: the principle stays general, the application names the
project's case. Give a project rule that no principle covers a bullet of its own in the
section it belongs to. Section numbers are stable: `CODING-RULES §N` comments in the
source refer to them.

---

## 1. Naming and Semantics

- Name functions, files and modules for their **purpose and domain**, not for the
  mechanism or API they call.
  - Applied: `startVM(name)`, `attachISO(vmName, slot, isoPath)` — never
    `callDomainMethod('UpdateDevice', ...)`.
  - Applied: name UI components and files after the user-visible tab and section names;
    when renaming a tab or section, rename the corresponding file and default export in
    the same change.
- Never write a generic action dispatcher (e.g. `performAction(name, action)`): give each
  operation its own purpose-named function.
- Avoid vague names like `doAction`, `update`, `handle`. Be specific:
  `executeDiskOperation`, `updateField`, `validateInput`.

## 2. Code Sharing — by Purpose, Not by Shape

- Share code only between call sites with the same purpose; keep similar-looking code
  with different purposes separate.
  - Applied: each VM and container operation has **one implementation**: what is
    generic libvirt or containerd in its manager, a workload command's orchestration in
    its side's operation module (§7); never in a route.
- Split a function whose parameters collect behaviour-changing booleans, rather than add
  another flag.
- Keep a shared helper in one module; never copy it between files.
  - Applied: the two managers each own their error factory, validators and path helpers
    (§7): those twins are not copies to merge.

## 3. Minimal External Dependencies

- Prefer the platform and the framework: don't add a library for what they provide or a
  small function does, and don't rebuild what they already offer.
  - Applied: parse `config/runtime.env` directly, with no `dotenv`; vendor noVNC by
    script, not as a package; use Node built-ins, not JWT, UUID or date libraries.
- Leave adding a dependency to the user: propose it with what it saves. Once agreed, add
  it at its latest stable version, actively maintained, with a line in `TECH-STACK.md`'s
  inventory.
  - Applied: never use a legacy name whose successor moved on: `@xterm/xterm`, not the
    deprecated `xterm`.
- Keep dependencies current; for a blocked upgrade, record why and when to recheck.

## 4. Structured Data Parsing

- Never parse structured formats (XML, JSON, YAML, HTML, etc.) with regular expressions.
  Use a dedicated parser.
  - Applied: parse domain XML with `fast-xml-parser` only, through the existing helpers
    (`parseDomainRaw`, `parseVMFromXML`, `buildXml`, `buildDiskXml`).
- When modifying a parsed document, extract the existing element and mutate it rather
  than construct a replacement from scratch.
  - Applied: to change a CD-ROM's medium, mutate its `<source>`; never rebuild the disk
    element.
- Read each value from where its format puts it, without generic discovery. When it isn't
  there, fail visibly rather than guess a plausible value.
- Read config strictly: reject unknown keys and wrong types at startup, so a typo fails,
  never silently defaults.

## 5. Error Handling

- Make errors **structured**: at minimum a stable `code` and a human-readable `message`.
  The language idiom that carries them (thrown objects, returned error values) is in §12.
  - Applied: throw `{ code, message, raw? }` from the managers through their private
    factories (`vmError` / `containerError`).
- Give API failure responses one shape across the application, unless an external API
  contract dictates another: `{ error, detail? }`, `error` the stable code, always
  present, and `detail` the human-readable message, where it adds value. Use the same
  shape on HTTP and streaming channels.
  - Applied: routes, hooks and jobs throw; one handler answers (`lib/appErrors.js`), the
    status from the one table of codes (`lib/errorCodes.js`). The body, its channels and
    every code: [`specs/ERROR-HANDLING.md`](specs/ERROR-HANDLING.md). A new code goes in
    the table and in that spec in the same change, and a wrapping error takes the inner
    one through `wrapAppError` (`lib/appErrors.js`) or its manager's twin, never by
    carrying its text in a message: `npm run check` fails otherwise.
- Prefer inspecting state up front and choosing the right path once, rather than
  try/catch/retry as control flow.
- Comment every silent `catch {}` block with why the error is intentionally swallowed.
  - Applied (settled 2026-11-23): the same holds for `.catch(() => {})` and the second
    argument of `.then`; a handler that drops its error says why or logs it, and
    `npm run check` fails otherwise.

## 6. Async Patterns and Timing

- Never use `sleep` or timer delays to work around race conditions. Use event signals, or
  retry with exponential backoff.
  - Applied: wait for state transitions on libvirt `DomainEvent` DBus signals, or retry
    with exponential backoff via `setImmediate`.
- Timers used for **scheduling** (periodic push updates, reconnect backoff, TTL cleanup,
  cron-like checks) are allowed.
  - Applied: the libvirt reconnect delay, SSE push intervals, job-TTL cleanup and the
    periodic apt checks — never a substitute for the correct readiness signal.
- Use `AbortController` (or the platform's cancellation primitive) for cancellable
  operations instead of boolean flags.
- Give every outbound request and subprocess a timeout; nothing waits forever.
  - Applied (settled 2026-11-13): choose each operation's timeout for what it does; there
    is no project-wide value. Where the operation shows progress (output on stdout or
    stderr, bytes written, stream data, progress events), the timeout is on inactivity:
    it fails after N seconds without progress, N set for that operation. Use a fixed
    total only where there is no progress signal (a DBus call, a short request). A review
    checks every new or changed operation for this.
- Prefer streaming over buffering: pipe data through transform streams instead of reading
  an entire payload into memory and then writing it out.
  - Applied: pipe file uploads from multipart to a write stream, never buffering whole
    files; run backups source → gzip → destination in one pipeline, never
    copy-then-compress.
- A response's or WebSocket's `'close'` event fires once, so a listener attached after an
  `await` never runs.
  - Applied: in SSE handlers, register every teardown (timers, subscriptions, job-stream
    registrations, log tails) through `onSSEClose(reply, fn)`, which runs `fn` at once
    when the response is already destroyed; never use `request.raw.on('close')`. In
    WebSocket handlers, re-check `socket.readyState !== socket.OPEN` after the setup
    `await` and tear down what that await produced (TCP leg, exec session) before
    returning.

## 7. Architecture Boundaries

- Reach an external system (a database, an API, a daemon) only through the subsystem that
  owns it: no other module imports its client library or opens a connection. Enforce it
  with a lint; meet a new need with one added line, flagged for review, never a way
  around the fence.
  - Applied: import `dbus-next` for libvirt only in `lib/vmManager/linux/` (behind the
    `vmManager` facade), `@grpc/grpc-js` only in `lib/containerManager/linux/` (behind
    its facade), Avahi's `dbus-next` only in `lib/mdns/linux/`, and `undici` only in
    `lib/outbound/` (settled 2026-11-12). Add a new operation as a new purpose-named
    facade export.
  - Applied: outbound HTTP has one home, `lib/outbound/` (settled 2026-11-20): no
    backend file outside it imports `undici` or Node's HTTP clients (a server's
    `createServer` aside), calls the global `fetch` or opens a WebSocket client. It has
    two fetches: `ssrfSafeFetch` for every URL from user input or a public source, and
    `fetchOperatorEndpoint` for an endpoint only the operator sets, the OIDC issuer
    (§9), which no file but `lib/oidc.js` may name. Inside `lib/outbound/` too, only
    the two files that implement those fetches import `undici` or call `fetch`. What
    speaks a remote API through them lives with its own subject: the image downloads in
    `lib/downloads/`, the certificate authority and Cloudflare in `lib/certificates/`.
  - Applied — the lint is `npm run check-fences`: the package fences, the facades (a
    module with an `index.js` is imported only through it), the strict managers and
    carved modules, routes that take no operation lock, outbound HTTP outside
    `lib/outbound/`, and the three shared-home rules below. A reviewed allowance is one
    line in its `EXCEPTIONS`.
  - Applied — **shared homes** (settled 2026-11-22): `lib/base/` is the one module every
    other may import, the strict managers and the carved modules included; it imports
    only Node builtins, and holds what all of them need and none should write again:
    the change emitter (`createEmitter`: a handler that throws is logged and the rest
    run), the privileged runner (`runPrivileged`: a helper is the one setup installs
    in `/usr/local/bin`, run through `sudo -n` with a time bound, its failure told
    apart as missing, refused, failed or timed out, and a helper's own exit code as
    invalid, not found or busy, §12) and the atomic write (settled 2026-11-23: a stored
    record is written to a temporary file beside it and renamed over it, by this one
    helper). The fence check holds three rules for it: no
    hand-written emitter outside `lib/base/`, no `'sudo'` outside its runner, and no
    `console.` in the backend (a module logs to the logger `configure()` handed it, the
    glue to `lib/log.js`; what runs before a logger exists, or at exit, writes to
    `process.stderr`). Add to `lib/base/` only what every kind of module needs.
  - Applied — **strict managers**: give vmManager and containerManager **zero Wisp-glue
    imports**: stdlib, their own internals, `lib/base/`, and the carved cross-cutting
    modules (`mdns/`, `networking/`, `storage/`) only. Change them only for **generic
    libvirt/containerd functionality**; put Wisp-specific orchestration (cloud-init flow,
    mDNS hooks, section assignments, cleanup rollbacks) in app-glue files (a workload
    command's in its side's operation module), kept flat at `lib/` top level so each
    manager stays independently extractable. Each
    manager owns its private error factory, validators and path helpers; give a generic
    primitive options rather than a Wisp-specific twin (`attachISO` / `ejectISO` carry
    `{ createIfMissing }` / `{ removeSlot }`, so cloud-init's slot rides the public
    primitive while its orchestration stays in `lib/cloudInit.js`).
  - Applied: the other carved modules (`host/`, `networking/`, `mdns/`, `storage/`) may
    import `createAppError` from `lib/appErrors.js` and `lib/base/`; only the managers
    are strict.
- Prefer native/API access over shelling out to CLI tools. Exec a binary only when there
  is no practical programmatic alternative, and confirm first.
  - Applied — the exec allowlist: `qemu-img`, `cp --reflink=auto` (with a `copyFile`
    fallback), `cloud-localds`/`genisoimage`, `openssl passwd`, `xz`, `tar`, `unzip`
    (`-Z1` listing + extract for container mount zip uploads), `mkfifo` (container exec
    stdio FIFOs), `systemd-notify --ready` (the start's readiness, under `Type=notify`;
    settled 2026-11-18), and, through `sudo -n` only, the privileged helpers
    (`wisp-os-update`, `wisp-mount`, `wisp-power`, `wisp-dmidecode`, `wisp-smartctl`,
    `wisp-nvram`, `wisp-netns`, `wisp-cni`, `wisp-bridge`) and
    `systemctl start wisp-updater.service`. The backend runs no network tool and no CNI
    plugin itself: the helpers do. Build-time only: `git` (noVNC vendoring). macOS dev
    stubs only: `system_profiler`, `vm_stat`, `sysctl`. Get the user's validation before
    adding anything else. A new privileged helper is a file in `backend/scripts/`, which
    setup installs with its sudo rule ([`specs/DEPLOYMENT.md`](specs/DEPLOYMENT.md), The
    helpers).

## 8. Frontend

In projects with a web UI: `FRONTEND-RULES.md`.

## 9. Security

- Validate and sanitise all user input at the **API boundary** with the one
  schema-validation mechanism named in `TECH-STACK.md`, not ad-hoc checks. Internal
  library functions may assume valid input.
  - Applied: every route declares the params, querystring and body it takes, and every MCP
    tool its `inputSchema`; one validator checks them (`lib/schemaValidation.js`), unknown
    keys refused and JSON never coerced, before the handler runs. A shape the schema can say
    is not checked again by hand; a handler keeps only what a schema cannot say. `npm run
    check` fails a route that lacks a schema it needs (the route report).
  - Applied: allow workload names of alphanumerics, hyphens, underscores and dots; reject
    traversal, empty and over-length names — one schema per kind (`lib/validation.js`),
    used by the routes and the MCP tools alike.
  - Applied: `lib/paths.js` is the **API-input security gate** for host paths: in routes,
    resolve and validate user-supplied paths there (`resolveLibraryPath`,
    `assertPathInsideAllowedRoots`) before passing absolute paths to the managers, which
    stay policy-agnostic about which host paths a deployment allows.
- Pass secrets to subprocesses via stdin or environment variables, never as command-line
  arguments (visible in process lists).
  - Applied: pass the cloud-init password to `openssl passwd -6` on stdin.
- Sanitise subprocess error output before exposing it to clients (e.g. mask credentials).
  - Applied: mask SMB passwords.
- Block requests to private/loopback addresses when the URL originates from user input
  (SSRF).
  - Applied: every URL from user input goes through `ssrfSafeFetch` (`lib/outbound`):
    the library's download URLs and the GitHub keys lookup, and with them the public
    sources whose redirects Wisp does not control (the image mirrors, GitHub Releases).
    One exception is an endpoint only the operator sets, the OIDC issuer and the
    endpoints its discovery names, fetched with `fetchOperatorEndpoint`, which allows
    private and loopback addresses so an identity provider on the LAN works, and follows
    no redirect (settled 2026-11-20). Setting the issuer is a session-only route
    ([`specs/AUTH.md`](specs/AUTH.md)), so no request can aim it.
    The other exception is a container image reference: user input, but pulled by
    containerd, not Wisp, from whatever registry it names, private and loopback ones
    included, because a registry on the LAN (or beside Wisp on the host) is a use Wisp
    supports by design (settled 2026-11-20).
- Never put auth tokens in URLs (`?token=...`): they get logged. Use cookies or
  `Authorization` headers.
- Never log secrets, tokens, credentials or whole request bodies.
- Require a verified session on the WebSocket console routes, as on every other route.
  `[PROJECT]`
- Create temp directories that hold credentials with a restrictive umask. `[PROJECT]`

## 10. Code Quality

- Remove all debug logging before committing.
- Keep a small helper used in only one file inline.
- Split large modules by **domain of functionality**, not arbitrarily. `[PROJECT]`
- Never commit commented-out code: version control history recovers old code.
- Match existing patterns over personal preference: the file's when editing, existing
  subsystems' when adding one.
  - Applied: make a new subsystem mirror the existing ones: facade module, domain split,
    dedicated store, dedicated routes (containers deliberately mirrored VMs).
- **Comment only what the code can't say:** why, a non-obvious constraint or invariant,
  or a contract callers rely on, in a sentence or two. Never restate the code or document
  a name that already says it. Leave out history, dates, who decided and plan steps:
  reasoning lives in the commit message. Name a rejected alternative only when the
  obvious approach fails.
  - Applied: when touching code, bring any history-narrating comment you meet up to this
    rule.

## 11. Code Style

- Prefer early returns. Use guard clauses at the top of functions to handle error/edge
  cases and return early, reducing nesting depth.
- Order imports consistently: (1) platform/standard library, (2) third-party packages,
  (3) project modules. Separate groups with a blank line.
  - Applied (settled 2026-11-23): `npm run check` holds it.

## 12. Language Rules `[PROJECT]`

### JavaScript

- Write plain JavaScript, ESM only; never TypeScript (`TECH-STACK.md`).
- Make every async function return a Promise. Throw errors as structured objects (§5).
- Prefer `const` over `let`; `let` only when reassignment is genuinely needed; never `var`.

### Go

For the CLI (`cli/`).

- Keep the code lint-clean (`TECH-STACK.md`, The CLI).
- Treat errors as values: wrap with `%w` and context (`fmt.Errorf("read config %s: %w",
  …)`), inspect with `errors.Is` / `errors.As`. Make an error that callers branch on a
  typed error (`type XError struct`) or a sentinel value (§5). An API refusal is one
  typed error that carries the code and the message as the server sent them.
- Pass `context.Context` as the first parameter of anything that does network I/O or may
  block; it is the cancellation primitive (§6).
- Give every goroutine an owner that can stop it and waits for it; never fire and forget
  a goroutine. The one exception: a read of standard input or of a file the user named,
  which no platform lets another goroutine interrupt everywhere. When its bound runs
  out the read is left behind and the program ends with the error.
- Keep package-level variables to constant-like data: lookup tables, sentinel errors,
  the build version. Pass mutable state in; `main` builds the graph.
- Put platform-specific code behind **build-tagged files** (`x_windows.go` /
  `x_unix.go`); every platform the CLI ships for compiles in the checks.

### Shell

- A script that handles a stop runs nothing in the foreground that can outlast the time it
  has to act on one: bash runs a trap only once the foreground command has ended.
  - Applied: a setup step runs nothing in the foreground that can outlast a network
    call's bound (`NET_CMD_SEC`); apt, dpkg, npm, downloads, applies, service starts and
    the bridge's check run in the background and are waited for (`step_run`), and those
    that show progress are stopped after a time without it.
- **A privileged helper** (`backend/scripts/wisp-*`, run as root through `sudo`) is
  written in one dialect (settled 2026-11-22):
  - **Who it defends against**: data, not the service user. The service user is root's
    equal by design (the `libvirt` group; it stages the tree an update installs). What a
    request body, a disk or a share can carry into an argument (a share name, a UUID, a
    container's name, a path) must not be able to add an option or name another file.
  - **Called as** `wisp-<name> <subcommand> <arguments in order>`: no flags, and nothing
    in the environment chooses what it runs or acts on (it reads only `SUDO_UID` and
    `SUDO_GID`, which sudo sets).
  - **The answer is on stdout** (lines, or one JSON document, as the helper's contract
    says) and nothing else is. **An error is one line on stderr**, `wisp-<name>: <what
    failed>`, the last thing printed; an error is never inside the answer. Only a helper
    whose contract shows progress (`wisp-os-update`, apt's output) writes to stderr
    before that line.
  - **Exit codes mean the same in every helper**: `0` done, `64` an argument is wrong,
    `2` the thing named is not there, `75` busy, try again, `1` anything else. No
    command's own code passes through. The runner turns the code into a reason
    (`invalid`, `not-found`, `busy`, `failed`), and a caller reads the reason, never the
    sentence.
  - **Every argument's form is checked before anything runs**: a name against its
    pattern, an option against its list, a path in canonical form, held under the
    folders it may be in, with no symbolic link below them. Only then does the helper
    look at what an argument names (is it there, is it a block device, whose file is
    it). `--` goes before a caller's operand, and no pattern admits a leading `-`. Where
    looking at a path can hang (the last part of a mount point on a dead share), the
    helper's spec says which part is not looked at.
  - **It bounds what it runs**: a signal sent to `sudo` does not reach the helper's
    child, so every command that can hang runs under a limit of the helper's own:
    `bounded <seconds> …`, or, for a long step that shows progress, a limit on the time
    without output. The backend's own limit for the call sits above the helper's worst
    case.
  - **It says when it could not do its job**: a failed read is never an empty answer,
    and a delete that did not happen is never success.
  - **The shared parts are in one file**, `backend/scripts/wisp-helper-lib.sh`, installed
    beside the helpers and sourced by them: the exit codes, the refusals, `bounded`, the
    path check, the shared patterns.
  - **Each helper has a test of its refusals** (`backend/scripts/test/`), run without
    root against stand-in commands: every wrong argument exits 64 with one line, an
    empty stdout and no command run.

## 13. Prompts and Model-Facing Text

Applied: Wisp's model-facing text is the MCP server's `initialize` instructions and its
tool descriptions ([`specs/MCP.md`](specs/MCP.md)).

- **Prompt fixes generalize.** When a prompt, skill or fragment produces a wrong output in
  a tested case, improve the general definition or accept the variance; never add an
  exception targeting exactly the observed case. A rule per failure is overfit teaching:
  if the general wording cannot be made better, record the miss in the backlog and watch
  it, never patch it.
- **Rule out only what the model would otherwise do.** A "no X" where nothing suggests X
  costs words and puts X in mind.
- **A rejection says what to do instead**: in a message a model reads when its call
  fails, name the step that works.
- **Write it in the imperative, concisely**: say what to do, in the shortest wording that
  keeps the meaning.

## 14. Verification `[PROJECT]`

Manager paths have no automated tests — verification is running the real thing, with the
checks and the unit tests below for what they cover:

- Run `npm run check` at the repo root after any change to code or scripts: it must
  pass (it needs `npm ci` at the root and in `frontend/`). It runs each check below and
  fails if any of them fails; the release workflow and `scripts/release.sh` run it too,
  so a failure blocks a release.
  - `check-imports`: every relative import in the backend and `shared/` resolves, every
    name one backend file imports from another is exported there, module-relative paths
    land in a directory that exists, and each platform facade's names are exported by
    its `linux/` and `darwin/` sides. The backend has no build step, so nothing else
    checks an import, and a dynamic one fails only when its code path runs. It also
    holds the import order (§11) in every script of the project, read from a parse.
  - `check-fences`: the import fences (§7); `shared/` importing nothing; no import cycle
    in the backend beyond its listed exceptions; and only the backend running the state
    migrations (§16).
  - `lint`: ESLint over `backend/`, `frontend/src/` and `shared/`, correctness rules
    only, a topic, change kind or job kind written as a string outside
    `shared/wireNames.js`, a handler that drops its error without saying why (§5), and
    a raw button outside the button primitives (FRONTEND-RULES, Buttons). Inline ESLint comments are not honoured, and one left in the
    code fails the check: an allowance is a reviewed line in `eslint.config.mjs`.
  - the shell check: `bash -n` and `shellcheck` over every shell script. shellcheck is
    required (settled 2026-11-22): the check fails without it. An inline
    `# shellcheck disable=` fails the check; an allowance is a reviewed line in
    `scripts/check-shell.mjs`. It also holds each script's mode to its use (executable
    if and only if it starts with a shebang; a sourced file has none and starts with
    `# shellcheck shell=bash`) and the helpers folder to helpers, the updater and their
    shared file.
  - `npm test`: the unit tests, `node --test` over the `*.test.js` files beside the
    modules they test and a migration's in `backend/migrations/test/`, for code with no
    platform behind it: timing, state and stream handling, rules. Platform code is
    verified by running it, below.
  - The CLI's Go checks (`scripts/check-go.mjs`): `gofmt`, `go vet` for every platform
    the CLI ships for, staticcheck, and `go test -race` (`TECH-STACK.md`, The CLI).
- Run the frontend build: it must pass.
- Drive the change in the local dev stack where the platform supports it. The macOS dev
  environment runs stub managers (no libvirt/containerd): host-level pages verify locally,
  while manager paths and workload detail verify on the Linux server. Component-level UI
  can be driven through a temporary Vite harness with canned fetch/SSE responses.
- Call a change **done** only after something was actually run and observed: never claim
  success without running something, and say plainly what could not be verified in the
  current environment.

## 15. Debugging

Find the root cause before fixing; never fix the symptoms. Never wrap code in speculative
try/catch.

- **Prove the failure mechanism before designing the fix.** Name the specific failure
  mode, then find the one-line check that proves it (a log tail while reproducing, a CLI
  probe, runtime state). If you can't articulate the check, you don't understand the bug
  yet: keep investigating.
  - Applied: the check is often a `journalctl` tail of `wisp.service` while reproducing.
    "Designing for both cases" usually means this step was skipped. When the user asks for
    manual validation, treat it as a real request — it usually catches a leap.
- **No second fallback for the same concern.**
  - Applied: fix the mechanism and trust events. One reconciler per legitimate concern is
    fine; a second polling or probing fallback for the same concern is clutter. Fall back
    to polling only when a real failure mode demands it — and ask first.

## 16. Stored Data

- Handle only the current shape of the stored data: no dual reads, no code for older
  shapes. Ship a shape change with the migration that brings the stored data to it.
  - Applied: the stored data is everything Wisp wrote: domain XML, `container.json`,
    `wisp-config.json`, `cloud-init.json`, `runtime.env`, `backup-status.json`, and file
    modes. Give no legacy code even to an artifact produced earlier in the same session.
    Bring what an earlier release wrote to the current shape with a **state migration**,
    run by the backend at every start before it reads stored state for anything else,
    and by nothing else (settled 2026-11-18): a start that did not come through the
    updater must not meet unmigrated state either. The contract, and the authoring
    rules: [`specs/UPDATES.md`](specs/UPDATES.md) → State migrations.
- Repair data left by a past bug with a migration too, never with code in the normal
  path.
- Run a change that touches more than one record in one transaction.
  - Applied: with no database, keep one record per file, written atomically
    (`writeJsonAtomic`: stage, fsync, rename).
- Store timestamps in UTC as ISO-8601 strings; convert them to local time only for
  display.
