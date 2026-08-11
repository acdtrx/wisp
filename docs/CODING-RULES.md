# Coding Rules

Coding principles for any contributor — human or coding agent — working on the
wisp codebase. Companion to [`CLAUDE.md`](../CLAUDE.md), which carries the
working method (triage, plans, verification, git) plus the authoritative
shell-exec allowlist. Each section states the general principle with its wisp
application.

Section numbers are stable: `CODING-RULES §N` comments in the source refer to
them. Two things deliberately live elsewhere: [`UI-PATTERNS.md`](UI-PATTERNS.md)
is the authority for list/table/row-editor UI, and file-level backend mechanics
(domain-XML conventions, DBus proxy caching, manager event wiring) live in
[`backend/src/lib/CLAUDE.md`](../backend/src/lib/CLAUDE.md) and `docs/spec/`.

---

## 1. Naming and Semantics

- Functions, files, and modules are named for their **purpose and domain**, not for the underlying mechanism or API they call: `startVM(name)`, `attachISO(vmName, slot, isoPath)` — never `callDomainMethod('UpdateDevice', ...)`.
- No generic action dispatchers (`performAction(name, action)`). Each operation gets its own purpose-named function.
- Avoid vague names like `doAction`, `update`, `handle`. Be specific: `executeDiskOperation`, `updateField`, `validateInput`.
- UI component and file names track the user-visible tab/section names. Renaming a tab or section renames the corresponding file and default export in the same change.

## 2. Code Sharing — by Purpose, Not by Shape

- Extract shared code only when the call sites serve the **same purpose**. Deduplicate by what the code *means* in the domain, not by what it happens to look like today.
- Two things that look similar but serve different purposes stay separate; a premature merge becomes a mega-component held together by flags. If a parameter list is accumulating behavior-changing booleans, split — don't add another flag.
- Wisp applied: Overview and Create VM share the section components via a single `isCreating` prop (one genuine shared purpose, one flag); vmManager and containerManager are the **single implementation** of every VM/container operation — no operation logic duplicated in routes.
- Shared utilities live in dedicated modules; never copy-paste the same helper into multiple files.

## 3. Minimal External Dependencies

- Do not add a library for functionality that can be implemented as a small function or that the platform already provides. Wisp applied: no `dotenv` — `config/runtime.env` is parsed directly; noVNC is vendored by script, not a package; no JWT/UUID/date libraries — Node built-ins.
- **Latest versions, verified.** Before adding a dependency, check the registry: the version being added must be the current latest release, and the package actively maintained — not deprecated, and not a legacy name whose successor moved on (wisp applied: `@xterm/xterm`, not the deprecated `xterm`). Keep existing dependencies at latest as routine maintenance; a genuinely blocked upgrade gets its block and recheck condition recorded instead of a silent pin.
- **No CDN-loaded assets.** All JS, CSS, and fonts bundled or system defaults. Body/UI text stays `system-ui, -apple-system, sans-serif`; custom faces are self-hosted woff2 with the license alongside, and the bundled display face (`--font-display`) is for brand moments only.
- Code-split heavy features with dynamic imports.
- `npm ci` for reproducible installs; lockfile ships with deploys.

## 4. Structured Data Parsing and Interpretation

- **Never parse or mutate XML (or any structured format) with regex.** Wisp uses `fast-xml-parser` exclusively, through the existing helpers (`parseDomainRaw`, `parseVMFromXML`, `buildXml`, `buildDiskXml`).
- When modifying domain XML, extract the existing element and mutate it (e.g. a CDROM's `<source>`) — do not construct a replacement from scratch.
- Parsing yields a tree, not meaning: read values from where each contract puts them, never by scanning for records that merely *look like* the target. Prefer designs whose failure mode is visible-and-absent over silent-and-plausible.

## 5. Error Handling

- Every async function returns a Promise. Managers throw **structured errors** `{ code, message, raw? }` via their private factories (`vmError` / `containerError`).
- Route handlers map codes to HTTP status (404, 409, 422, 500, 503 when libvirt/backend is unreachable) and return `{ error, detail }` — `detail` is `err.raw || err.message`. SSE errors ride the same shape (`{ error, detail, code? }`; job streams use `{ step: 'error', error, detail }`). See [`spec/ERROR-HANDLING.md`](spec/ERROR-HANDLING.md).
- Errors shown to the user are **sticky** — visible until dismissed, no auto-dismiss on later success.
- Prefer inspecting state up front and choosing the right path once over try/catch/retry as control flow.
- Every silent `catch {}` needs a comment explaining why the error is swallowed.

## 6. Async Patterns and Timing

- **Never `sleep` or timer delays to paper over race conditions.** State-transition waits use libvirt `DomainEvent` DBus signals, or retry with exponential backoff via `setImmediate`.
- Timers for **scheduling** are fine (libvirt reconnect delay, SSE push intervals, job-TTL cleanup, periodic apt checks) — they must never substitute for the correct readiness signal.
- `AbortController` for cancellable operations, not boolean flags.
- Streaming over buffering: file uploads pipe multipart to a write stream (never buffer whole files); backups run source → gzip → destination in one pipeline (never copy-then-compress).

## 7. Architecture Boundaries

- **Single external-system callers.** Only `backend/src/lib/vmManager/linux/` (plus the `vmManager.js` facade) imports `dbus-next` for libvirt; only `backend/src/lib/containerManager/linux/` (plus facade) imports `@grpc/grpc-js`. Avahi's `dbus-next` use lives in `lib/mdns/linux/` only. New operations = new purpose-named facade exports.
- **Strict managers.** vmManager and containerManager carry **zero Wisp-glue imports** — stdlib, their own internals, and the carved cross-cutting modules (`mdns/`, `networking/`, `storage/`) only. Changes to them are appropriate only for **generic libvirt/containerd functionality**; Wisp-specific orchestration (cloud-init flow, mDNS hooks, section assignments, cleanup rollbacks) lives in routes or app-glue files, which stay flat at `lib/` top-level so each manager remains independently extractable.
- **Manager events are push, not pull**: subscribe-and-replay surfaces on the facade — fire only on change, replay current state to new subscribers, keep platform plumbing private. New event surfaces follow the same pattern.
- **Decouple mechanism from trigger.** Any background or maintenance mechanism (update poll, apt checks, job-TTL cleanup, reconcilers) is an invocable unit; its triggers — boot, schedule, events, a manual run — are wired separately, and any trigger can invoke any mechanism. A manual invocation must always work, for testing or because it is needed now. Every execution logs what triggered it and the result.
- `paths.js` is the **API-input security gate**: routes resolve and validate user-supplied paths there before passing absolute paths to the policy-agnostic managers.
- Prefer DBus/gRPC over shelling out. Every exec'd binary must be on the approved allowlist in [`CLAUDE.md`](../CLAUDE.md); new binaries — and especially new privileged `wisp-*` helpers — are a team decision, registered per the checklist in [`spec/DEPLOYMENT.md`](spec/DEPLOYMENT.md).
- **Live data is pushed.** Always-on feeds are topics on the single multiplexed `/api/events` SSE stream — never new dedicated always-on endpoints (browsers cap plain HTTP/1.1 at 6 connections per origin). View-scoped streams (per-entity stats, logs, job progress) stay dedicated. No repeated-GET polling for live data. The stream stays on the custom fetch-based `createSSE`: native EventSource was evaluated and rejected — it can't observe keepalive comments (no dead-TCP watchdog) nor distinguish 401s.
- The server is the source of truth: VM metadata lives in domain XML, container config in `container.json` — never authoritative state in localStorage.
- Fastify route **response schemas are authoritative** for serialized output — new response fields need the schema updated in the same edit or Fastify strips them.
- CORS allows `localhost:5173` in development only; production fronts everything through the frontend proxy.

## 8. Frontend Patterns

- One Zustand store per subsystem, mirroring the established `vmStore` patterns; SSE via `createSSE` / `createJobSSE` and the `/api/events` topic singleton.
- Initialise form state from the config's defaults — never `useState({})` and hope.
- Effect dependencies are **stable**: primitives or serialised representations, never object references that change identity every render; `useCallback` for handlers passed to effects or children.
- Lazy-load heavy features (Console tab) with `React.lazy` / dynamic import.
- Lists, tables, and row editors follow [`UI-PATTERNS.md`](UI-PATTERNS.md) — row-scoped saves, header add actions, shared table chrome.
- **Action buttons are icon-only by default**, with `title` / `aria-label`. Visible text labels only for primary form actions (Create/Save/Cancel at form bottoms) or on explicit request.
- Dialogs go through `ConfirmDialog` / `AlertDialog` — never `window.confirm()` / `window.alert()`.

## 9. Security

- Validate and sanitise all user input at the **API boundary**; internal functions may assume valid input. Workload names: alphanumeric, hyphens, underscores, dots; reject traversal, empty, over-length.
- Secrets to subprocesses via **stdin or env, never argv** (cloud-init password → `openssl passwd -6` on stdin).
- Sanitise subprocess error output before exposing it to clients (SMB passwords masked).
- Rate-limit auth endpoints; keying uses `request.ip` only — no `x-forwarded-for` fallback.
- SSRF: block private/loopback addresses in user-supplied download URLs.
- The WebSocket console route requires JWT verification.
- Never put auth tokens in URLs (`?token=...`) — they get logged. Use cookies or `Authorization` headers.
- Temp directories holding credentials are created with a restrictive umask.

## 10. Code Quality

- Remove all debug logging before committing.
- Fix root causes, not symptoms; no workaround scripts patching over bugs.
- Split large modules by **domain of functionality**, not arbitrarily; small single-use helpers stay inline.
- No commented-out code — version control history holds the past.
- **Comments hold current agreements only.** A comment states the constraint, invariant, or reasoning that is true *now* — never the code's own history: no "since <date>", no "used to be", no narration of previous iterations. Git is the archive. Naming a rejected alternative is allowed only when it documents a live constraint (why the obvious approach fails), not what this code did before. When touching code, bring any history-narrating comment you meet up to this rule.
- New subsystems mirror existing patterns: facade module, domain split, dedicated store, dedicated routes (containers deliberately mirrored VMs).

## 11. Code Style

- Early returns; guard clauses at the top reduce nesting.
- Import order: (1) platform/stdlib, (2) third-party, (3) project modules — blank line between groups.
- One exported UI component per file; unexported local sub-components may share it.
- Colocate related files per feature.
- `const` by default; `let` only for genuine reassignment; never `var`.

## 12. Container App Modules

- New app registry entries default to **non-root** — omit `requiresRoot` unless there is a concrete identified need: a privileged port bound without capability tricks, startup writes to root-owned paths *inside the image rootfs* (not mount points), or capabilities effectively tied to UID 0.
- "The upstream image's `USER` defaults to 0" is not a reason. Wisp's mount pre-owning and GID model already solve the pain points that push raw-Docker setups to root. Try non-root, watch the first-boot logs, and flip only on a real `EACCES` that a tmpfs or pre-owned Local mount can't fix.
- Unnecessary root costs real things: storage-sourced writes landing as overflowuid on SMB shares, delete-time idmap gymnastics, and a worse blast radius.

## 13. Prompts and Model-Facing Text

Wisp does not call LLMs; its model-facing text is the MCP server instructions
and tool descriptions.

- **Prompt fixes generalize.** When model-facing text produces a wrong outcome in a tested case, improve the general definition or accept the variance — never add an exception targeting exactly the observed case. A rule per failure is overfit teaching; if the general wording cannot be made better, the miss is recorded in the backlog and watched, not patched.
