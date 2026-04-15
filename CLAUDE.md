# Wisp — Project Rules

## Design Principles

- **Naming:** Functions named for purpose (e.g. `attachISO(vmName, slot, isoPath)`), not for DBus method. No `callDomainMethod('UpdateDevice', ...)`.
- **No generic action API:** No single `performAction(name, action)` string-switch in the backend. Use purpose-named functions (e.g. `startVM(name)`).
- **Promises and errors:** Every function returns a Promise. Errors thrown as `{ code, message, raw? }`. Route handlers map codes to HTTP status (404, 409, 422, 500). Routes return `{ error: string, detail: string }` on failure.
- **No sleep/timers for race conditions:** Do not use `setTimeout`, `setInterval`, or artificial delays to paper over state races. State-transition waits use DomainEvent DBus signals or retry with exponential backoff via `setImmediate`. Other backend timers are allowed for non-race purposes (e.g. libvirt reconnect delay, SSE push intervals, job TTL cleanup, periodic apt checks).
- **Single DBus/libvirt caller:** Only `backend/src/lib/linux/vmManager/` (and the `vmManager.js` facade) may import `dbus-next` for **libvirt** or talk to libvirt. Avahi/mDNS uses `dbus-next` only in `linux/mdnsManager.js`. Routes and other libs must not import `dbus-next` for libvirt. New VM operations = new purpose-named export from the vmManager facade.
- **Single gRPC/containerd caller:** Only `backend/src/lib/linux/containerManager/` (and the `containerManager.js` facade) may import `@grpc/grpc-js` or talk to containerd. Routes and other libs must not import `@grpc/grpc-js`. New operations = new purpose-named export from the containerManager facade.
- **Minimize dependencies:** Don't add a module for functionality that can be implemented as a small function — write the function instead.
- **No duplicated functionality:** Overview and Create VM share section components via `isCreating` prop. vmManager is the single implementation for every VM operation.
- **CORS:** Backend allows CORS from `localhost:5173` only when `NODE_ENV=development`. Production: frontend proxies `/api` and `/ws`.
- **No CDN assets:** No cdn, jsdelivr, unpkg, googleapis in frontend. Fonts: `font-family: system-ui, -apple-system, sans-serif` only.
- **Shell/CLI:** No shell exec of binaries unless the alternative is very complex; validate with the user if the code should exec a CLI.
- **No regex for XML:** Do not parse or mutate XML with regex. Use `fast-xml-parser` (parseDomainRaw / parseVMFromXML, buildXml, buildDiskXml) already used in the project.
- **Live data via SSE:** All data that updates over time (host stats, VM list, per-VM stats, job progress, etc.) must be pushed via SSE (or WebSocket where applicable). Do not use repeated GET requests (polling). One-time GET is fine for static or user-triggered data.
- **UI section names and file names:** Keep component and file names aligned with user-visible section or tab names. When renaming a tab or section in the UI, rename the corresponding files and default export.

## Changelog

- **Update `CHANGELOG.md` before every `git push`.** Add a new dated section at the **top** (format `## YYYY-MM-DD`) covering every commit since the previous push. Group entries under `### New Features` and `### Bug Fixes`. One line per entry, very terse — summarize intent, not implementation. Never touch older sections.

## Deployability

- **Wisp is a deployable application.** Fixes and changes should be made **in the app** (functionality or setup) so it works out of the box for future installs, not one-off fixes on the server.
- **Setup and configuration:** Fix setup/configuration issues in the install and setup scripts (e.g. `scripts/install.sh`, `scripts/setup-server.sh`, `scripts/linux/setup/*.sh`). Prefer improving the pipeline over documenting manual server steps.
- **Manual server fixes** are appropriate only when actively debugging or testing, not as the intended long-term resolution.

## Feature Building (No Migrations)

The project is in **feature-building** mode.

**Out of scope** (without an explicit decision to end this mode):
- Automatic upgrade paths between intentional product versions
- Dual-read of deprecated keys or old on-disk shapes
- Legacy support for multiple historical schemas

Implement new behavior against the **target schema and APIs** only.

**In scope:** Bug fixes that caused wrong persisted state (incorrect file ownership/permissions, bad paths, inconsistent data). Fixing root causes and corrective repair of state produced by bugs is normal engineering, not forbidden "migration" work.

## Docs and Spec Sync

When you change behavior, APIs, UI, or configuration, update the corresponding doc in the same edit.

| Content | Doc |
|---------|-----|
| Architecture (system overview, modules, data flow) | `docs/ARCHITECTURE.md` |
| Tech stack (dependencies, versions) | `docs/TECHSTACK.md` |
| API (routes, request/response, errors) | `docs/spec/API.md` |
| UI (layout, components, views, empty states) | `docs/spec/UI.md` |
| Backend (vmManager, lifecycle, XML) | `docs/spec/VM-MANAGEMENT.md`, `docs/spec/ERROR-HANDLING.md` |
| Containers (containerManager, containerd, OCI, CNI) | `docs/spec/CONTAINERS.md` |
| Auth / login | `docs/spec/AUTH.md` |
| Config / env / paths | `docs/spec/CONFIGURATION.md` |
| Console / VNC | `docs/spec/CONSOLE.md`, `docs/spec/noVNC.md` |
| Host stats / monitoring | `docs/spec/HOST-MONITORING.md` |
| Backups, snapshots, cloud-init, USB, image library, deployment, etc. | Same-name spec in `docs/spec/` |
| Project rules / coding standards | `docs/CODING-RULES.md`, `docs/WISP-RULES.md` |

## Pre-Implementation Analysis

Before writing or modifying any code (skip only for trivial typo/comment-only edits):

1. **Read relevant docs first.** Always read `docs/CODING-RULES.md` and `docs/WISP-RULES.md`, plus the area-specific specs from the table above.
2. **Verify your plan** — check existing behavior in specs, error handling patterns (`{ code, message, raw? }` → `{ error, detail }`), API contract, SSE for live data, `fast-xml-parser` for XML, dependency justification, architecture boundaries (vmManager for libvirt, containerManager for containerd, paths.js for filesystem).
3. **Implement following documented patterns:**
   - Backend: Purpose-named functions, structured errors, single DBus caller (vmManager), no sleep for races
   - Frontend: Zustand stores, SSE via `createSSE`/`createJobSSE`, shared sections with `isCreating`, system fonts only
   - Routes: `{ error, detail }` on failure, `handleRouteError` for vmManager errors, `sendError` for others
   - Scripts: Fix in the install/setup pipeline, quote variables, `set -e`
4. **Update docs** to reflect changes (see Docs and Spec Sync section above).
