# Internal Modules & Boundaries — Refactor Campaign

## Goal

Untangle the shared `backend/src/lib/*.js` flat dependency surface into a small set of named, single-purpose internal modules with clear boundaries. This is a precondition for eventually extracting `vmManager` and `containerManager` as two independent reusable libraries (a separate, later effort).

This refactor stays **inside Wisp** — no package extraction, no port interfaces, no API changes. Just internal restructuring with named module boundaries.

## Non-goals

- No extraction to npm packages (yet).
- No port/adapter interface design (yet).
- No behavior changes, no API changes, no UI changes.
- No backwards-compatibility shims — feature-building mode (per `CLAUDE.md`). Renames are direct, all call sites updated in the same commit.

## How to use this document

- This is a **multi-session** refactor. Sessions can pick up at any uncompleted step.
- **Status** below points to the current step. Update it when starting/finishing a step.
- Each step is **self-contained** — a fresh reader (or fresh Claude) should be able to execute step N by reading only its section, without needing the conversation that produced this plan.
- **Step 1 is fully detailed.** Steps 2–6 are sketched only. The detail for step N+1 is filled in *after* step N completes (because step N usually surfaces facts that change later steps).
- **Decisions log** at the bottom — append one line per non-obvious tradeoff resolved during execution. Stops us relitigating it next session.
- After each completed step: update `CHANGELOG.md`, run the app, verify nothing broke, commit. One step = one (or few) commits.

## Status

- **Current step:** Step 5 — Paths & config (sketched, needs detailing)
- **Completed:** Step 1 — Networking & Bridges (2026-05-03), Step 2 — mDNS (2026-05-03), Step 3 — Storage primitives (2026-05-03), Step 4 — Host introspection (2026-05-03), Step 4b — containerApps carve-out (2026-05-03)

## Boundaries identified (overview)

These are the internal modules to carve out of the flat `backend/src/lib/` surface, in execution order. Order is driven by which leaks block the "two independent libs" goal most directly.

| # | Module | Why first/last | Status |
|---|--------|----------------|--------|
| 1 | **Networking & bridges** | Only true cross-leak: `containerManager` imports from `vmManager`. Unblocking this means the two managers become independent. | done |
| 2 | **mDNS** | Both managers and several other modules reach into mDNS directly. Group under one named module. | done |
| 3 | **Storage primitives** | `diskOps`, `smbMount`, `diskMount` — generic disk operations, currently flat. | done |
| 4 | **Host introspection** | `hostHardware`, `hostGpus`, `usbMonitor`, proc readers. Already partially under `linux/host/`. | done |
| 5 | **Paths & config** | Hardest. Wisp-specific `wisp-config.json` schema lives here. Save for last — this is the policy boundary that will eventually become the port interface. | sketched |
| 6 | **Validation, errors** | `validation.js` is fine to share. `routeErrors.js` stays in routes (managers throw structured errors already — that's the right boundary). Mostly a naming/organizing pass. | sketched |

---

## Step 1 — Networking & Bridges

### Why this step first

`containerManager/containerManagerCreate.js` imports `getDefaultContainerParentBridge` from `vmManager/vmManagerHost.js`. This is the only place where the two managers cross-import. Until this leak is cleaned up, they can't be independent libs. Networking is also consumed by routes, so the new module will have multiple legitimate consumers — not just the two managers.

### Scope — files moving

Source files (all paths relative to `backend/src/lib/`):

| Current location | Status | Notes |
|------------------|--------|-------|
| `bridgeNaming.js` | move | Pure heuristic (`isVlanLikeBridgeName`). Tiny. |
| `hostNetworkBridges.js` | move + rename | Currently a platform dispatcher to `linux/host/hostNetworkBridges.js`. |
| `linux/host/hostNetworkBridges.js` | move | Linux impl of bridge listing. |
| `darwin/host/hostNetworkBridges.js` | move (if exists) | Darwin stub. Verify during implementation. |
| `linux/host/linuxProcIpv4.js` | move | Used by `containerManagerNetwork.js` for CIDR-from-FIB-trie. |
| `linux/vmManager/vmManagerHost.js` → `getDefaultContainerParentBridge` | **extract function**, leave the rest in vmManagerHost | This is the cross-leak. Investigate: does this fn use libvirt? If yes, decide whether it stays in vmManager and gets exposed to networking via callback, OR is rewritten to use only host-level introspection. **Decision deferred to implementation.** |

Target layout:

```
backend/src/lib/networking/
  index.js                  # facade (re-exports public surface)
  bridgeNaming.js           # moved verbatim
  hostBridges.js            # platform dispatcher (was hostNetworkBridges.js)
  defaultBridge.js          # getDefaultContainerParentBridge (extracted)
  linux/
    hostBridges.js          # linux impl (was linux/host/hostNetworkBridges.js)
    procIpv4.js             # was linux/host/linuxProcIpv4.js
  darwin/
    hostBridges.js          # darwin stub if it exists
```

(Folder layout final names TBD during implementation — the principle is what matters: one named module, one facade entry point.)

### New module's public surface (`networking/index.js`)

Tentative — to be confirmed by reading the actual exports during implementation:

- `isVlanLikeBridgeName(name)` — from `bridgeNaming`
- `listHostBridges()` — from `hostBridges`
- `getDefaultContainerParentBridge()` — extracted
- `ipv4CidrFromProcFibTrie(...)` — from `procIpv4`
- Anything else currently exported from `hostNetworkBridges.js` that is used externally

### Call sites to update

Confirmed by `grep` at plan-write time:

- `backend/src/lib/linux/vmManager/index.js` — re-export of bridges
- `backend/src/lib/linux/vmManager/vmManagerHost.js` — `isVlanLikeBridgeName` import + `getDefaultContainerParentBridge` definition
- `backend/src/lib/linux/containerManager/containerManagerCreate.js` — `getDefaultContainerParentBridge` import (the cross-leak)
- `backend/src/lib/linux/containerManager/containerManagerNetwork.js` — `linuxProcIpv4` import
- `backend/src/lib/linux/host/hostNetworkBridges.js` — `bridgeNaming` import
- `backend/src/lib/vmManager.js` — facade
- `backend/src/lib/darwin/vmManager/index.js` — darwin facade
- `backend/src/routes/host.js` — direct consumer of bridges

(Re-grep before starting, in case new call sites have appeared since this plan was written.)

### Done when

- New `backend/src/lib/networking/` module exists with a facade `index.js`.
- `containerManager` no longer imports from `vmManager` (run: `grep -rE "from ['\"].*/vmManager/" backend/src/lib/linux/containerManager/` should return nothing).
- `vmManager` no longer imports from `containerManager` (verify symmetrically).
- Routes that need bridge info import from `networking`, not `hostNetworkBridges`.
- `vmManagerHost.js` no longer defines `getDefaultContainerParentBridge`.
- Backend boots, frontend loads, listing VMs and containers works, creating a container with default network still works (this is the path that uses `getDefaultContainerParentBridge`).
- `CLAUDE.md` and any spec mentioning these files updated.
- One commit (or a small series), changelog updated.

### Open questions for implementation

- Does `getDefaultContainerParentBridge` currently use libvirt internally? If yes, the cleanest fix may not be "move it to networking" — it may be "rewrite it to read /sys/class/net or libvirt's network-list without going through the domain object." Decide during implementation, log decision below.
- Do we keep the `linux/`/`darwin/` platform-dispatch pattern at the networking module level, or only at file level? Probably yes (consistency), but confirm.

---

## Step 2 — mDNS  *(sketched — to be detailed before starting)*

**Files in scope (rough):** `mdnsManager.js`, `mdnsHostname.js`, `mdnsForwarder.js`, `vmMdnsPublisher.js`, `containerMdnsReconciler.js`, `linux/mdnsServiceTypes.js`.

**Cross-leak to fix:** Both managers import `mdnsManager` directly. Group as one named module with a single facade.

**Open questions:** Where do `vmMdnsPublisher` and `containerMdnsReconciler` live — inside the mDNS module, or alongside the respective managers as their consumers of mDNS? Probably the latter (they're glue, not core mDNS), but decide during step 2 detailing.

---

## Step 3 — Storage primitives  *(sketched)*

**Files in scope:** `diskOps.js` (qemu-img wrappers), `smbMount.js`, `diskMount.js`, `linux/host/diskMonitor.js`, `linux/host/diskSmart.js`.

**Note:** `diskOps.js` is generic enough that it'll likely ship with whichever lib needs it (probably both). For this internal step, just group them under `lib/storage/`.

---

## Step 4 — Host introspection

### Why this step

Seven top-level `lib/*.js` facade files dispatch to `lib/linux/host/*` and `lib/darwin/host/*` impls — a flat surface that doesn't match the named-module pattern established in steps 1–3. Goal: consolidate into a single `lib/host/` module with one `index.js` facade, matching the layout of `networking/`, `mdns/`, `storage/`. Also resolves a manager→host deep import (`containerManager` reaches into `linux/host/linuxProcUptime.js`).

### Scope — files moving

Source files (paths relative to `backend/src/lib/`):

| Current location | Target | Notes |
|------------------|--------|-------|
| `hostHardware.js` | **delete** | Replaced by `host/index.js` export. |
| `hostGpus.js` | **delete** | Replaced by `host/index.js` export. |
| `hostPower.js` | **delete** | Replaced by `host/index.js` export. |
| `usbMonitor.js` | **delete** | Replaced by `host/index.js` export. |
| `procStats.js` | **delete** | Replaced by `host/index.js` export. |
| `rebootRequired.js` | **delete** | Replaced by `host/index.js` export. |
| `aptUpdates.js` | **delete** | Replaced by `host/index.js` export — and the `apt`-ism is dropped (export names already platform-neutral; impls already named `osUpdates.js`). |
| `pciIds.js` | move → `host/linux/pciIds.js` | Internal helper (not facade-exported). Sole consumers are `host/linux/hostHardware.js` and `host/linux/hostGpus.js`. |
| `linux/host/hostHardware.js` | move → `host/linux/hostHardware.js` | |
| `linux/host/hostGpus.js` | move → `host/linux/hostGpus.js` | |
| `linux/host/hostPower.js` | move → `host/linux/hostPower.js` | |
| `linux/host/usbMonitor.js` | move → `host/linux/usbMonitor.js` | |
| `linux/host/procStats.js` | move → `host/linux/procStats.js` | |
| `linux/host/rebootRequired.js` | move → `host/linux/rebootRequired.js` | |
| `linux/host/osUpdates.js` | move → `host/linux/osUpdates.js` | |
| `linux/host/linuxProcUptime.js` | move → `linux/containerManager/procUptime.js` | **Cross-leak fix.** Sole consumers are `containerManagerList.js` + `containerManagerStats.js`. Drop the `linux` prefix — already platform-scoped by directory. Not exposed from host facade. |
| `darwin/host/hostHardware.js` | move → `host/darwin/hostHardware.js` | |
| `darwin/host/hostGpus.js` | move → `host/darwin/hostGpus.js` | |
| `darwin/host/hostPower.js` | move → `host/darwin/hostPower.js` | |
| `darwin/host/usbMonitor.js` | move → `host/darwin/usbMonitor.js` | |
| `darwin/host/procStats.js` | move → `host/darwin/procStats.js` | |
| `darwin/host/rebootRequired.js` | move → `host/darwin/rebootRequired.js` | |
| `darwin/host/osUpdates.js` | move → `host/darwin/osUpdates.js` | |
| `darwin/host/systemProfilerHardware.js` | move → `host/darwin/systemProfilerHardware.js` | Internal helper for darwin `hostHardware`. |
| `darwin/host/systemProfilerSoftware.js` | move → `host/darwin/systemProfilerSoftware.js` | Internal helper. |
| `storage/linux/smart.js` | move → `host/linux/smart.js` | **Revising step 3.** Sole consumer is `hostHardware.js`. SMART is host introspection in spirit (machine inventory, not VM/container disk-image ops). See decisions log. |
| `storage/darwin/smart.js` | move → `host/darwin/smart.js` | Mirrors above. |

After moves, `linux/host/` and `darwin/host/` directories are empty and removed.

Target layout:

```
backend/src/lib/host/
  index.js                          # facade: platform dispatch + re-exports
  linux/
    hostHardware.js
    hostGpus.js
    hostPower.js
    usbMonitor.js
    procStats.js
    rebootRequired.js
    osUpdates.js
    smart.js                        # SMART — moved from storage/linux/
    pciIds.js                       # internal helper — moved from lib/
  darwin/
    hostHardware.js
    hostGpus.js
    hostPower.js
    usbMonitor.js
    procStats.js
    rebootRequired.js
    osUpdates.js
    smart.js                        # darwin stub
    systemProfilerHardware.js       # internal helper for darwin hostHardware
    systemProfilerSoftware.js       # internal helper
```

### `host/index.js` public surface

Single facade — platform dispatch via top-level `await import()`, then re-export. Mirrors mdns/storage facades.

```js
// from hostHardware
export const getHostHardwareInfo
// from hostGpus
export const listHostGpus
// from hostPower
export const hostShutdown, hostReboot
// from usbMonitor
export const start, stop, getDevices, onChange
// from procStats
export const getHostStats
// from rebootRequired
export const getRebootSignal
// from osUpdates  (replaces aptUpdates.js facade)
export const getPendingUpdatesCount, setCachedUpdateCount, getLastCheckedAt,
             checkForUpdates, performUpgrade, listUpgradablePackages,
             startUpdateChecker, stopUpdateChecker
// from smart  (moved from storage/index.js)
export const readDiskSmartSummary, readAllDiskSmartSummaries
```

`pciIds.js` is **not** part of the public surface — it's an internal helper used only by host's own Linux impls.

### Call sites to update

Confirmed by grep at plan-write time:

- `backend/src/index.js` — imports from `aptUpdates.js`, `usbMonitor.js`
- `backend/src/routes/host.js` — imports from `aptUpdates.js`, `hostHardware.js`, `hostPower.js`, `hostGpus.js`, `usbMonitor.js`
- `backend/src/routes/stats.js` — imports from `procStats.js`, `aptUpdates.js`, `rebootRequired.js`
- `backend/src/lib/storage/index.js` — drop SMART re-exports + the `smartImpl` dynamic import
- `backend/src/lib/linux/containerManager/containerManagerList.js` — `linuxProcUptime` import path
- `backend/src/lib/linux/containerManager/containerManagerStats.js` — same

(Re-grep before starting — new sites may have appeared.)

### Internal relative-path updates inside moved files

- `host/linux/hostHardware.js`: `'../../pciIds.js'` → `'./pciIds.js'`; `'../../storage/index.js'` (for `readAllDiskSmartSummaries`) → `'./smart.js'`.
- `host/linux/hostGpus.js`: `'../../pciIds.js'` → `'./pciIds.js'`.
- `host/{linux,darwin}/hostPower.js`: `'../../routeErrors.js'` → `'../../routeErrors.js'` (path identical from new depth — both old and new are two levels deep). **Verify**.
- `host/{linux,darwin}/osUpdates.js`: same routeErrors-relative-depth check.
- `linux/containerManager/procUptime.js`: no external imports today (pure /proc reads).

### Done when

- New `backend/src/lib/host/` module exists with `linux/`, `darwin/`, and a single `index.js` facade.
- The seven top-level facade files are gone (`hostHardware.js`, `hostGpus.js`, `hostPower.js`, `usbMonitor.js`, `procStats.js`, `rebootRequired.js`, `aptUpdates.js`).
- `pciIds.js` no longer at `lib/` top-level.
- `lib/linux/host/` and `lib/darwin/host/` directories no longer exist.
- `storage/index.js` no longer re-exports SMART; `storage/linux/smart.js` and `storage/darwin/smart.js` no longer exist.
- `containerManager` no longer imports from `host/` at all (run: `grep -rE "from ['\"].*/host/" backend/src/lib/linux/containerManager/` returns nothing).
- Backend boots, host stats SSE works, `/api/host` returns hardware/GPU/USB data, OS-update check still works, container list shows uptime correctly.
- Docs updated: `ARCHITECTURE.md` (flat-lib table + tree), `HOST-MONITORING.md` (paths to darwin profiler / hostHardware), `CONTAINERS.md` (`linuxProcUptime` → `procUptime`), `lib/CLAUDE.md` if needed. `CHANGELOG.md` updated.

### Open questions for implementation

(All major questions resolved before starting — see decisions log entries dated 2026-05-03 [step 4]. The remaining unknowns are local relative-path checks during execution, listed under "Internal relative-path updates" above.)

### Out of scope (deferred to step 6)

- Splitting `routeErrors.js` into a Wisp-glue translator (`handleRouteError` + `errorCodeToStatus` + `sendError` + `curateDetail`) and per-module `errors.js` factories. The host impls already import `createAppError` from `lib/routeErrors.js`; preserve those imports as-is in step 4. Step 6 does the cross-cutting refactor uniformly across all modules — same mechanism applied piecemeal here would be inconsistent for one or two sessions.

---

## Step 5 — Paths & config (the policy boundary)  *(sketched)*

**Hardest step.** This is where Wisp-specific `wisp-config.json` schema, install paths, and VM/container directory conventions live. Files: `paths.js`, `config.js`, `loadRuntimeEnv.js`, `atomicJson.js`, `settings.js`.

When we eventually extract the libs, *this* is the surface that becomes a port interface (the lib asks "where do I store container X's config?" and Wisp answers). For now, just consolidate and name the boundary clearly so the eventual port design is obvious.

**Detail before starting:** map every `paths.js` and `config.js` consumer; identify which calls are policy ("which directory?") vs. generic ("write JSON atomically").

---

## Step 6 — Validation, errors, leftovers  *(sketched)*

Mostly cleanup. `validation.js` stays shared. `routeErrors.js` stays in routes (managers already throw structured errors — correct boundary). Anything still flat in `backend/src/lib/` that didn't fit a category gets sorted or kept flat with justification.

---

## Decisions log

Append one line per non-obvious tradeoff resolved during execution. Format: `YYYY-MM-DD — [step N] — decision — why`.

- 2026-05-03 — [step 1] — `getDefaultContainerParentBridge` moves to `networking/` verbatim — verified it's pure host introspection (`/sys/class/net` reads), no libvirt usage. No callback/rewrite needed. Same for `listHostBridges` and `getDefaultBridge` — all three siblings extracted together since they share `listHostBridges` and form a coherent host-bridge unit.
- 2026-05-03 — [step 1] — Layout collapsed to 6 files (no top-level dispatcher files; `index.js` does platform dispatch directly) — initial sketch had 8 files including separate `hostBridges.js`/`managedBridges.js` dispatchers; removed them since `index.js` already serves as the facade.
- 2026-05-03 — [step 1] — Cross-platform-agnostic helper `isVlanLikeBridgeName` kept in standalone `bridgeNaming.js` despite being 4 lines — both `linux/hostBridges.js` and `linux/managedBridges.js` need it; putting it in `index.js` would risk circular-init via top-level `await import`.
- 2026-05-03 — [step 1] — `networking/linux/managedBridges.js` originally kept static imports of `vmManager` and `containerManager` (for `assertBridgeNotInUse`), but this created a top-level-await cycle on Linux (vmManager TLA → networking TLA → managedBridges static-imports vmManager). Fixed by switching to dynamic `import()` inside `assertBridgeNotInUse`. macOS dev didn't reproduce it because `darwin/managedBridges.js` has no cross-deps. **Lesson for steps 2+:** verify Linux module-load with the *facade* entry point, not standalone file imports, before declaring done.
- 2026-05-03 — [step 2] — `vmMdnsPublisher` and `containerMdnsReconciler` stay at `lib/` top-level as **app-level glue**, NOT moved inside their respective managers. Reason: extraction goal — vmManager/containerManager need to be reusable libs in projects that don't want mDNS. Glue is Wisp-specific orchestration policy (when to publish, what hostname, how often to reconcile); other apps would write their own glue against the same event surfaces (`subscribeDomainChange`, `subscribeAgentEvent`). Codified the rule in `docs/WISP-RULES.md` § Architecture. Step 2 only carved out the mDNS *core* (`lib/mdns/`).
- 2026-05-03 — [step 2] — `mdnsServiceTypes.js` lifted from `lib/linux/` to `lib/mdns/serviceTypes.js` — was misfiled as Linux-specific despite being a platform-agnostic catalog + regex validators. Re-exported from the facade.
- 2026-05-03 — [step 2] — Renamed `mdnsManager.js` → `avahi.js` inside the module — more accurate (the Linux backend is specifically Avahi, not generic mDNS), and the directory `mdns/` already carries the context. Same for `mdnsForwarder.js` → `forwarder.js`, `mdnsHostname.js` → `hostname.js`.
- 2026-05-03 — [step 2] — Internal-only exports (`lookupLocalEntry`, `resolveLocalName`, `resolveLocalAddress`) stay private to the linux pair `avahi.js` ↔ `forwarder.js` — used only by the forwarder, not part of the public mDNS surface. Preserves the existing circular static import (no TLA, function bindings only — ESM handles it).
- 2026-05-03 — [step 3] — `diskSmart` (SMART summaries) moves into `storage/`, NOT host introspection. Reason: SMART is a property of disks, not of the host's hardware enumeration. `hostHardware.js` (which moves in step 4) becomes the *consumer* of `storage.readAllDiskSmartSummaries`, not the owner. Renamed `diskSmart.js` → `linux/smart.js` inside the new module (drop redundant prefix; sibling to `diskMount.js`/`smbMount.js`). Added a darwin stub returning `[]`.
- 2026-05-03 — [step 3] — Quietest step so far. No manager↔manager cross-leaks, no TLA cycles. Storage doesn't import either manager (consumers only flow one way: `vmManager`/`containerManager`/`mountsAutoMount`/`settings`/routes → storage). `mountsAutoMount.js` stays at `lib/` top-level as Wisp app-level glue (boot mount-reconcile + hotplug policy).
- 2026-05-03 — [step 4] — Module root is `lib/host/` (new), not consolidating into the existing `lib/linux/host/` directory. Reason: matches the pattern of `lib/networking/`, `lib/mdns/`, `lib/storage/` — cross-platform module root with `linux/`/`darwin/` subdirs inside. Step 4's earlier sketch was ambiguous; this pins the layout.
- 2026-05-03 — [step 4] — `linuxProcUptime.js` moves into `linux/containerManager/` (renamed `procUptime.js` — already platform-scoped by directory) instead of being exposed from the host facade. Reason: containerManager is the sole consumer; the file is functionally a containerManager helper that happens to read /proc, not a general host-introspection primitive. Resolves the only manager→host deep import.
- 2026-05-03 — [step 4] — `pciIds.js` moves to `host/linux/pciIds.js` as an internal helper (not facade-exported). Reason: only consumers are `host/linux/hostHardware.js` and `host/linux/hostGpus.js`. De-facto host-Linux internal data; not part of the host module's public contract.
- 2026-05-03 — [step 4] — The `apt`-named facade (`aptUpdates.js`) is dropped at consolidation time. Reason: facade was named after the Linux package manager but already dispatched to a generic `osUpdates.js` (Linux + darwin stub). Consolidating into `host/index.js` is the cheap moment to normalize the public surface name. Three call sites updated.
- 2026-05-03 — [step 4] — Single facade with re-exports (matching `mdns/index.js`, `storage/index.js`), not multiple sub-facades. Reason: keep import shape uniform across modules; ~15 exports is fine.
- 2026-05-03 — [step 4] — `bootCleanup.js` is **not** in scope. Reason: it's `paths.js` + `atomicJson.js` + `settings.js` glue (atomic-write janitor), not host introspection. Belongs to step 5 (paths & config). Calling it out to preempt scope drift since the name sounds host-y.
- 2026-05-03 — [step 4] — Revising step 3's SMART decision: `storage/linux/smart.js` and `storage/darwin/smart.js` move to `host/linux/smart.js` and `host/darwin/smart.js`. Public `readDiskSmartSummary` / `readAllDiskSmartSummaries` exports move from `storage/index.js` to `host/index.js`. Reason: sole consumer is `hostHardware.js`. Step 3 placed SMART in `storage/` on conceptual grounds ("SMART is a property of disks"), but the empirical test for the extraction goal is "what does each consumer of the module actually use?" — neither `vmManager` nor `containerManager` will ever need SMART (they care about VM disk-image files via `diskOps.js`). Keeping SMART in `storage/` means storage carries a public export no extracted consumer would call. Host introspection is the better home: SMART is part of the machine inventory the user sees in the dashboard.
- 2026-05-03 — [step 4] — `routeErrors.js` consolidation deferred to step 6. Existing `createAppError` imports inside host impls (`hostPower.js`, `osUpdates.js` on both platforms) preserved as-is. Reason: the right end-state is to split `routeErrors.js` into a Wisp-glue translator (`handleRouteError` + `errorCodeToStatus` + `sendError` + `curateDetail`, kept under `routes/`) and per-module `errors.js` factories — but doing this in step 4 only would leave storage/networking/mdns/managers using the shared factory, an asymmetry that lasts a session or two. Step 6 applies the split uniformly across all modules.
- 2026-05-03 — [step 4] — Two extra `host/` deep-imports surfaced during execution that the plan-write call-site list missed: `linux/vmManager/vmManagerHost.js` and `darwin/vmManager/index.js` both reached into the old `host/usbMonitor.js` for `getDevices` (VM USB attach needs to know what's plugged in). Fixed by switching both to `host/index.js` (facade, not deep). `linux/containerManager/apps/jellyfin.js` had the same shape against `host/hostGpus.js` (GPU passthrough lookup) — also moved to facade. **Lesson for step 5+:** when grepping call sites, search for `linux/host/` and `darwin/host/` deep imports as well as the top-level facade imports — the deep imports inside other manager modules are easy to miss in the initial sweep.
- 2026-05-03 — [step 4 follow-up] — Dropped `vmManager.listHostUSBDevices()` entirely (Linux + darwin). The function was a one-line pass-through to `host.getDevices()`; the only consumer (`GET /api/host/usb`) now calls the host facade directly. Reason: the relay added a fake responsibility to vmManager (it didn't *do* anything with the data, just forwarded it) and meant vmManager carried a host dependency for purely cosmetic reasons. With this gone, vmManager → host has zero imports. The only manager → host coupling left is `containerManager/apps/jellyfin.js` calling `listHostGpus()` — that's real policy (existence check + first-device pick for `/dev/dri/renderD*` passthrough), not a relay; deferred decision on whether to push the policy into the route layer or keep it in the app module.
- 2026-05-03 — [step 4b] — Carved `apps/` out of `linux/containerManager/` into a new top-level `lib/containerApps/` (cross-platform — apps are pure config translators, not OS-specific). containerApps is now a *peer* of routes, not an extension of containerManager. It consumes containerManager primitives (`createContainer`, `updateContainerConfig`, `putMountFileTextContent`, `execCommandInContainer`, `getContainerConfig`, `getTaskState`, `deleteContainer`) and orchestrates the app create/patch/eject flows. Schema change: `container.json` now persists app identity in opaque `metadata.app` (string id) + `metadata.appConfig` (object) — containerManager never introspects `metadata`, just persists it verbatim. UI updated to read `config.metadata?.app` / `config.metadata?.appConfig`. **Manager drops ~160 lines** of app-aware code (`containerManagerCreate.js` lines 408–451 for app expansion + mount-content writing; `containerManagerConfig.js` lines 128–242 for eject/appConfig handling, reload-vs-restart logic, mount-layout-changed computation). Manager **gains** `metadata` and `pendingRestart` as generic writable fields plus generic spec-field handling for env/mounts/devices/services/runAsRoot at create. Existing app containers under feature-building mode: `metadata` field absent → UI treats them as generic containers; users can recreate to restore app UI activation. **Net dependency edges:** `containerManager → containerApps` = ZERO; `containerApps → containerManager` = consumer-only; `containerApps → host` = jellyfin's GPU enumeration (legitimate glue → host coupling); `containerApps → settings` = jellyfin's storage-mount lookup. Routes dispatch on `config.metadata?.app` to either containerApps glue or generic manager calls.
