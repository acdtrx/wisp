# Coding Rules

Generic principles for how code is written, tested and debugged, for any contributor
(human or coding agent) working on this codebase. They are project-independent, except §12
(`[PROJECT]`), the project's language rules.

Projects specialize these rules by weaving their concrete instances inline
("Applied: …") under the matching principle — the principle stays general, the
application names the project's case. A project rule that no principle covers is a bullet
of its own in the section it belongs to. Section numbers are stable: `CODING-RULES §N`
comments in the source refer to them.

---

## 1. Naming and Semantics

- Functions, files, and modules are named for their **purpose and domain**, not for the underlying
  mechanism or API they call.
  - Applied: `startVM(name)`, `attachISO(vmName, slot, isoPath)` — never
    `callDomainMethod('UpdateDevice', ...)`.
  - Applied: UI component and file names track the user-visible tab and section names;
    renaming a tab or section renames the corresponding file and default export in the
    same change.
- No generic action dispatchers (e.g. `performAction(name, action)`). Each operation gets its own
  purpose-named function.
- Avoid vague names like `doAction`, `update`, `handle`. Be specific: `executeDiskOperation`,
  `updateField`, `validateInput`.

## 2. Code Sharing — by Purpose, Not by Shape

- Share code only between call sites with the same purpose; similar-looking code with different
  purposes stays separate.
  - Applied: vmManager and containerManager are the **single implementation** of every
    VM and container operation — no operation logic is duplicated in routes.
- A parameter list collecting behaviour-changing booleans is the signal to split, not to add a
  flag.
  - Applied: Overview and Create VM share their section components through a single
    `isCreating` prop — one genuine shared purpose, one flag.
- Shared helpers live in one module, never copied between files.

## 3. Minimal External Dependencies

- Prefer the platform and the framework: don't add a library for what they provide or a small
  function does, and don't rebuild what they already offer.
  - Applied: no `dotenv` — `config/runtime.env` is parsed directly; noVNC is vendored by
    script, not a package; no JWT, UUID or date libraries — Node built-ins.
- Adding a dependency is the user's call: propose it with what it saves. It enters at its latest
  stable version, actively maintained, and gets a line in `TECH-STACK.md`'s inventory.
  - Applied: never a legacy name whose successor moved on — `@xterm/xterm`, not the
    deprecated `xterm`.
- Keep dependencies current; a blocked upgrade records why and when to recheck.

## 4. Structured Data Parsing

- Never parse structured formats (XML, JSON, YAML, HTML, etc.) with regular expressions. Use a
  dedicated parser.
  - Applied: domain XML goes through `fast-xml-parser` only, by way of the existing
    helpers (`parseDomainRaw`, `parseVMFromXML`, `buildXml`, `buildDiskXml`).
- When modifying a parsed document, extract the existing element and mutate it rather than
  constructing a replacement from scratch.
  - Applied: changing a CD-ROM's medium mutates its `<source>`; it never rebuilds the disk
    element.
- Read each value from where its format puts it, without using generic discovery. When it isn't
  there, fail visibly rather than guess a plausible value.
- Config is read strictly: unknown keys and wrong types are rejected at startup — a typo
  fails, never silently defaults.

## 5. Error Handling

- Errors are **structured**: at minimum a stable `code` and a human-readable `message`. The
  language idiom that carries them (thrown objects, returned error values) is in §12.
  - Applied: managers throw `{ code, message, raw? }` through their private factories
    (`vmError` / `containerError`).
- API responses on failure use a consistent shape across the entire application, unless an
  external API contract dictates another: `{ error, detail? }` — `error` the stable code,
  always present; `detail` the human-readable message, where it adds value. The same shape
  applies on HTTP and streaming channels.
  - Applied: route handlers map codes to HTTP status (404, 409, 422, 500, and 503 when
    libvirt or the backend is unreachable) and return `{ error, detail }`, `detail` being
    `err.raw || err.message`. SSE errors ride the same shape (`{ error, detail, code? }`;
    job streams use `{ step: 'error', error, detail }`). See
    [`specs/ERROR-HANDLING.md`](specs/ERROR-HANDLING.md).
- Prefer inspecting state up front and choosing the right path once, rather than try/catch/retry as
  control flow.
- Every silent `catch {}` block must have a comment explaining why the error is intentionally
  swallowed.

## 6. Async Patterns and Timing

- Never use `sleep` or timer delays to work around race conditions. Use event signals, or retry
  with exponential backoff.
  - Applied: state-transition waits use libvirt `DomainEvent` DBus signals, or retry with
    exponential backoff via `setImmediate`.
- Timers used for **scheduling** (periodic push updates, reconnect backoff, TTL cleanup, cron-like
  checks) are allowed.
  - Applied: the libvirt reconnect delay, SSE push intervals, job-TTL cleanup and the
    periodic apt checks — never a substitute for the correct readiness signal.
- Use `AbortController` (or the platform's cancellation primitive) for cancellable operations
  instead of boolean flags.
- Every outbound request and subprocess has a timeout; nothing waits forever.
- Prefer streaming over buffering: pipe data through transform streams instead of reading an
  entire payload into memory and then writing it out.
  - Applied: file uploads pipe multipart to a write stream, never buffering whole files;
    backups run source → gzip → destination in one pipeline, never copy-then-compress.
- A response's or WebSocket's `'close'` event fires once, so a listener attached after an
  `await` never runs.
  - Applied: SSE handlers register every teardown (timers, subscriptions, job-stream
    registrations, log tails) through `onSSEClose(reply, fn)`, which runs `fn` at once
    when the response is already destroyed — never `request.raw.on('close')`. WebSocket
    handlers re-check `socket.readyState !== socket.OPEN` after their setup `await` and tear
    down what that await produced (TCP leg, exec session) before returning.

## 7. Architecture Boundaries

- An external system (a database, an API, a daemon) is reached only through the subsystem
  that owns it: no other module imports its client library or opens a connection. A lint
  enforces it; a new need is one added line, flagged for review, never a way around the
  fence.
  - Applied: only `lib/vmManager/linux/` (behind the `vmManager` facade) imports
    `dbus-next` for libvirt; only `lib/containerManager/linux/` (behind its facade) imports
    `@grpc/grpc-js`; Avahi's `dbus-next` use lives in `lib/mdns/linux/` only. A new
    operation is a new purpose-named facade export.
  - Applied — **strict managers**: vmManager and containerManager carry **zero Wisp-glue
    imports** — stdlib, their own internals, and the carved cross-cutting modules
    (`mdns/`, `networking/`, `storage/`) only. A change to them is appropriate only for
    **generic libvirt/containerd functionality**; Wisp-specific orchestration (cloud-init
    flow, mDNS hooks, section assignments, cleanup rollbacks) lives in routes or in app-glue
    files, which stay flat at `lib/` top level so each manager remains independently
    extractable. Each manager owns its private error factory, validators and path helpers;
    a generic primitive takes options rather than a Wisp-specific twin (`attachISO` /
    `ejectISO` carry `{ createIfMissing }` / `{ removeSlot }`, so cloud-init's slot rides
    the public primitive while its orchestration stays in `lib/cloudInit.js`).
- Prefer native/API access over shelling out to CLI tools. Only exec a binary when there is no
  practical programmatic alternative, and confirm first.
  - Applied — the exec allowlist: `qemu-img`, `cp --reflink=auto` (with a `copyFile`
    fallback), `cloud-localds`/`genisoimage`, `openssl passwd`, `xz`, `tar`, `unzip`
    (`-Z1` listing + extract for container mount zip uploads), `mkfifo` (container exec
    stdio FIFOs), `ip netns add|delete` (container netns fallback only when the
    `wisp-netns` helper is absent — works only with the backend as root), the privileged
    helpers `wisp-os-update`, `wisp-mount`, `wisp-power`, `wisp-dmidecode`,
    `wisp-smartctl`, `wisp-nvram`, `wisp-netns`, `wisp-cni`, `wisp-bridge`,
    `systemctl start wisp-updater.service` (via `sudo -n`), and CNI plugins under
    `/opt/cni/bin/`. Build-time only: `git` (noVNC vendoring). macOS dev stubs only:
    `system_profiler`, `vm_stat`, `sysctl`. Anything else needs the user's validation
    first. A new privileged `wisp-*` helper is registered in
    `scripts/linux/setup/install-helpers.sh` and documented per the checklist in
    [`specs/DEPLOYMENT.md`](specs/DEPLOYMENT.md).

## 8. Frontend

In projects with a web UI: `FRONTEND-RULES.md`.

## 9. Security

- Validate and sanitise all user input at the **API boundary** using the one schema-validation
  mechanism named in `TECH-STACK.md`, not ad-hoc checks. Internal library functions may assume
  valid input.
  - Applied: workload names are alphanumeric, hyphens, underscores and dots; traversal,
    empty and over-length names are rejected.
  - Applied: `lib/paths.js` is the **API-input security gate** for host paths — routes
    resolve and validate user-supplied paths there (`resolveLibraryPath`,
    `assertPathInsideAllowedRoots`) before passing absolute paths to the managers, which
    stay policy-agnostic about which host paths a deployment allows.
- Pass secrets to subprocesses via stdin or environment variables, never as command-line arguments
  (visible in process lists).
  - Applied: the cloud-init password reaches `openssl passwd -6` on stdin.
- Sanitise subprocess error output before exposing it to clients (e.g. mask credentials).
  - Applied: SMB passwords are masked.
- Block requests to private/loopback addresses when the URL originates from user input (SSRF).
  - Applied: user-supplied download URLs.
- Never put auth tokens in URLs (`?token=...`) — they get logged. Use cookies or `Authorization`
  headers.
- Logs never carry secrets, tokens, credentials or whole request bodies.
- The WebSocket console routes require a verified session, like every other route.
- Temp directories holding credentials are created with a restrictive umask.

## 10. Code Quality

- Remove all debug logging before committing.
- If a helper is small and used in only one file, keep it inline.
- Large modules are split by **domain of functionality**, not arbitrarily.
- No commented-out code in the repository. Use version control history to recover old code.
- Match existing patterns over personal preference: the file's when editing, existing
  subsystems' when adding one.
  - Applied: a new subsystem mirrors the existing ones — facade module, domain split,
    dedicated store, dedicated routes (containers deliberately mirrored VMs).
- **Comment only what the code can't say:** why, a non-obvious constraint or invariant, or a
  contract callers rely on, in a sentence or two. Don't restate the code or document a name that
  already says it. No history, dates, who decided or plan steps: design reasoning lives in
  `docs/`, cited by name. A rejected alternative only when the obvious approach fails.
  - Applied: when touching code, bring any history-narrating comment you meet up to this
    rule.

## 11. Code Style

- Prefer early returns. Use guard clauses at the top of functions to handle error/edge cases and
  return early, reducing nesting depth.
- Consistent import ordering: (1) platform/standard library, (2) third-party packages,
  (3) project modules. Separate groups with a blank line.

## 12. Language Rules `[PROJECT]`

### JavaScript

- Plain JavaScript, ESM only — no TypeScript (`TECH-STACK.md`).
- Every async function returns a Promise. Errors are thrown as structured objects (§5).
- Prefer `const` over `let`; `let` only when reassignment is genuinely needed; never `var`.

## 13. Prompts and Model-Facing Text

Applied: Wisp's model-facing text is the MCP server's `initialize` instructions and its
tool descriptions ([`specs/MCP.md`](specs/MCP.md)).

- **Prompt fixes generalize.** When a prompt, skill or fragment produces a wrong output in
  a tested case, improve the general definition or accept the variance — never add an
  exception targeting exactly the observed case. A rule per failure is overfit teaching;
  if the general wording cannot be made better, the miss is recorded in the backlog and
  watched, not patched.
- **Rule out only what the model would otherwise do.** A "no X" where nothing suggests X
  costs words and puts X in mind.
- **A rejection says what to do instead**: a message a model reads when its call fails
  names the step that works.
- **Write it in the imperative, concisely**: say what to do, in the shortest wording that
  keeps the meaning.

## 14. Verification `[PROJECT]`

Wisp has no automated test suite — verification is running the real thing:

- The frontend build must pass.
- `npm run check-imports` must pass after any backend file move or rename. The backend has
  no build step, so nothing else validates import paths — and a *dynamic* import only
  resolves when its code path runs, so a stale one boots fine and 500s a single route
  later. It also checks module-relative paths (`resolve(__dirname, '…')`,
  `new URL('…', import.meta.url)`) land in a directory that exists.
- Drive the change in the local dev stack where the platform supports it. The macOS dev
  environment runs stub managers (no libvirt/containerd): host-level pages verify locally,
  while manager paths and workload detail verify on the Linux server. Component-level UI
  can be driven through a temporary Vite harness with canned fetch/SSE responses.
- A change is **done** only after something was actually run and observed — never claim
  success without running something, and say plainly what could not be verified in the
  current environment.

## 15. Debugging

Find the root cause before fixing, never fix the symptoms. No speculative try/catch
wrapping.

- **Prove the failure mechanism before designing the fix.** Name the specific failure
  mode, then find the one-line check that proves it (a log tail while reproducing, a
  CLI probe, runtime state). If you can't articulate the check, you don't understand
  the bug yet — keep investigating.
  - Applied: the check is often a `journalctl` tail of `wisp.service` while reproducing.
    "Designing for both cases" usually means this step was skipped. When the user asks for
    manual validation, treat it as a real request — it usually catches a leap.
- **No second fallback for the same concern.**
  - Applied: fix the mechanism and trust events. One reconciler per legitimate concern is
    fine; a second polling or probing fallback for the same concern is clutter. Fall back
    to polling only when a real failure mode demands it — and ask first.

## 16. Stored Data

- Code handles only the current shape of the stored data: no dual reads, no code for older
  shapes. A shape change ships with the migration that brings the stored data to it.
  - Applied: the stored data is libvirt domain XML, `container.json`, `wisp-config.json`
    and file modes — not even an artifact produced earlier in the same session gets
    legacy code. A **state migration** brings what an earlier release wrote to the current
    shape during the update, with the backend stopped (settled 2026-10-16):
    `backend/migrations/NNNN-short-name.js`, run once per host by
    `backend/scripts/migrate.mjs`. The contract, and the authoring rules the runner cannot
    check: [`specs/UPDATES.md`](specs/UPDATES.md) → State migrations.
- Repairing data left by a past bug is a migration too, never code in the normal path.
- A change that touches more than one record runs in one transaction.
  - Applied: with no database, one record is one file, written atomically
    (`writeJsonAtomic`: stage, fsync, rename).
- Timestamps are stored in UTC as ISO-8601 strings, and converted to local time only for
  display.
