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
  - Applied: keep vmManager and containerManager the **single implementation** of every
    VM and container operation; never duplicate operation logic in routes.
- Split a function whose parameters collect behaviour-changing booleans, rather than add
  another flag.
  - Applied: Overview and Create VM share their section components through a single
    `isCreating` prop — one genuine shared purpose, one flag.
- Keep a shared helper in one module; never copy it between files.

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
  - Applied: in route handlers, map codes to HTTP status (404, 409, 422, 500, and 503
    when libvirt or the backend is unreachable) and return `{ error, detail }`, `detail`
    being `err.raw || err.message`. Send SSE errors in the same shape
    (`{ error, detail, code? }`; job streams use `{ step: 'error', error, detail }`). See
    [`specs/ERROR-HANDLING.md`](specs/ERROR-HANDLING.md).
- Prefer inspecting state up front and choosing the right path once, rather than
  try/catch/retry as control flow.
- Comment every silent `catch {}` block with why the error is intentionally swallowed.

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
    its facade), and Avahi's `dbus-next` only in `lib/mdns/linux/`. Add a new operation
    as a new purpose-named facade export.
  - Applied — **strict managers**: give vmManager and containerManager **zero Wisp-glue
    imports**: stdlib, their own internals, and the carved cross-cutting modules
    (`mdns/`, `networking/`, `storage/`) only. Change them only for **generic
    libvirt/containerd functionality**; put Wisp-specific orchestration (cloud-init flow,
    mDNS hooks, section assignments, cleanup rollbacks) in routes or in app-glue files,
    kept flat at `lib/` top level so each manager stays independently extractable. Each
    manager owns its private error factory, validators and path helpers; give a generic
    primitive options rather than a Wisp-specific twin (`attachISO` / `ejectISO` carry
    `{ createIfMissing }` / `{ removeSlot }`, so cloud-init's slot rides the public
    primitive while its orchestration stays in `lib/cloudInit.js`).
- Prefer native/API access over shelling out to CLI tools. Exec a binary only when there
  is no practical programmatic alternative, and confirm first.
  - Applied — the exec allowlist: `qemu-img`, `cp --reflink=auto` (with a `copyFile`
    fallback), `cloud-localds`/`genisoimage`, `openssl passwd`, `xz`, `tar`, `unzip`
    (`-Z1` listing + extract for container mount zip uploads), `mkfifo` (container exec
    stdio FIFOs), `ip netns add|delete` (container netns fallback only when the
    `wisp-netns` helper is absent — works only with the backend as root), the privileged
    helpers `wisp-os-update`, `wisp-mount`, `wisp-power`, `wisp-dmidecode`,
    `wisp-smartctl`, `wisp-nvram`, `wisp-netns`, `wisp-cni`, `wisp-bridge`,
    `systemctl start wisp-updater.service` (via `sudo -n`), and CNI plugins under
    `/opt/cni/bin/`. Build-time only: `git` (noVNC vendoring). macOS dev stubs only:
    `system_profiler`, `vm_stat`, `sysctl`. Get the user's validation before adding
    anything else. Register a new privileged `wisp-*` helper in
    `scripts/linux/setup/install-helpers.sh` and document it per the checklist in
    [`specs/DEPLOYMENT.md`](specs/DEPLOYMENT.md).

## 8. Frontend

In projects with a web UI: `FRONTEND-RULES.md`.

## 9. Security

- Validate and sanitise all user input at the **API boundary** with the one
  schema-validation mechanism named in `TECH-STACK.md`, not ad-hoc checks. Internal
  library functions may assume valid input.
  - Applied: allow workload names of alphanumerics, hyphens, underscores and dots; reject
    traversal, empty and over-length names.
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
  - Applied: user-supplied download URLs.
- Never put auth tokens in URLs (`?token=...`): they get logged. Use cookies or
  `Authorization` headers.
- Never log secrets, tokens, credentials or whole request bodies.
- Require a verified session on the WebSocket console routes, as on every other route.
- Create temp directories that hold credentials with a restrictive umask.

## 10. Code Quality

- Remove all debug logging before committing.
- Keep a small helper used in only one file inline.
- Split large modules by **domain of functionality**, not arbitrarily.
- Never commit commented-out code: version control history recovers old code.
- Match existing patterns over personal preference: the file's when editing, existing
  subsystems' when adding one.
  - Applied: make a new subsystem mirror the existing ones: facade module, domain split,
    dedicated store, dedicated routes (containers deliberately mirrored VMs).
- **Comment only what the code can't say:** why, a non-obvious constraint or invariant,
  or a contract callers rely on, in a sentence or two. Never restate the code or document
  a name that already says it. Leave out history, dates, who decided and plan steps:
  design reasoning lives in `docs/`, cited by name. Name a rejected alternative only when
  the obvious approach fails.
  - Applied: when touching code, bring any history-narrating comment you meet up to this
    rule.

## 11. Code Style

- Prefer early returns. Use guard clauses at the top of functions to handle error/edge
  cases and return early, reducing nesting depth.
- Order imports consistently: (1) platform/standard library, (2) third-party packages,
  (3) project modules. Separate groups with a blank line.

## 12. Language Rules `[PROJECT]`

### JavaScript

- Write plain JavaScript, ESM only; never TypeScript (`TECH-STACK.md`).
- Make every async function return a Promise. Throw errors as structured objects (§5).
- Prefer `const` over `let`; `let` only when reassignment is genuinely needed; never `var`.

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

Wisp has no automated test suite — verification is running the real thing:

- Run the frontend build: it must pass.
- Run `npm run check-imports` after any backend file move or rename: it must pass. The
  backend has no build step, so nothing else validates import paths — and a *dynamic*
  import only resolves when its code path runs, so a stale one boots fine and 500s a
  single route later. It also checks module-relative paths (`resolve(__dirname, '…')`,
  `new URL('…', import.meta.url)`) land in a directory that exists.
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
  - Applied: the stored data is libvirt domain XML, `container.json`, `wisp-config.json`
    and file modes; give no legacy code even to an artifact produced earlier in the same
    session. Bring what an earlier release wrote to the current shape with a **state
    migration** during the update, with the backend stopped (settled 2026-10-16):
    `backend/migrations/NNNN-short-name.js`, run once per host by
    `backend/scripts/migrate.mjs`. The contract, and the authoring rules the runner
    cannot check: [`specs/UPDATES.md`](specs/UPDATES.md) → State migrations.
- Repair data left by a past bug with a migration too, never with code in the normal
  path.
- Run a change that touches more than one record in one transaction.
  - Applied: with no database, keep one record per file, written atomically
    (`writeJsonAtomic`: stage, fsync, rename).
- Store timestamps in UTC as ISO-8601 strings; convert them to local time only for
  display.
