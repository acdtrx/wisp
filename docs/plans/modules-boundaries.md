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

- **Current step:** None — campaign complete.
- **Completed:** Step 1 — Networking & Bridges (2026-05-03), Step 2 — mDNS (2026-05-03), Step 3 — Storage primitives (2026-05-03), Step 4 — Host introspection (2026-05-03), Step 4b — containerApps carve-out (2026-05-03), Step 5 — Manager configure() / push model (2026-05-04), Step 6 — Manager independence + jobs/downloads grouping (2026-05-04)

## Boundaries identified (overview)

These are the internal modules to carve out of the flat `backend/src/lib/` surface, in execution order. Order is driven by which leaks block the "two independent libs" goal most directly.

| # | Module | Why first/last | Status |
|---|--------|----------------|--------|
| 1 | **Networking & bridges** | Only true cross-leak: `containerManager` imports from `vmManager`. Unblocking this means the two managers become independent. | done |
| 2 | **mDNS** | Both managers and several other modules reach into mDNS directly. Group under one named module. | done |
| 3 | **Storage primitives** | `diskOps`, `smbMount`, `diskMount` — generic disk operations, currently flat. | done |
| 4 | **Host introspection** | `hostHardware`, `hostGpus`, `usbMonitor`, proc readers. Already partially under `linux/host/`. | done |
| 5 | **Paths & config** | Hardest. Wisp-specific `wisp-config.json` schema lives here. Save for last — this is the policy boundary that will eventually become the port interface. | done |
| 6 | **Manager independence + leftovers** | Five edges from vmManager/containerManager into Wisp app glue broken: routeErrors (inline), validation (vendor), cloudInit (move out + generalize ISO primitives), vmMdnsPublisher (move publish calls to route), sections (move rename to route). `lib/jobs/` and `lib/downloads/` grouped. Strict-managers rule documented. | done |

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

## Step 5 — Manager configure() / push model

### Outcome

Both managers carry **zero Wisp-glue policy imports** after this step. Wisp pushes paths and the storage-mount resolver via `configure()` at boot; managers never reach for `paths.js`, `config.js`, `settings.js`, or `atomicJson.js`.

### What we did (no folder reorg — push model only)

1. **vmManager**
   - New private `lib/linux/vmManager/vmManagerPaths.js` holds `getVMBasePath`, `getImagePath`, `getVmsPath`, `assertPathInsideAllowedRoots`. Reads from a configure-time slot.
   - Linux + darwin facades expose `configure({ vmsPath, imagePath })`.
   - 7 internal files (`Create`, `Disk`, `Iso`, `CloudInit`, `Snapshots`, `Backup`, `Config`) switched from `'../../paths.js'` / `'../../config.js'` to `'./vmManagerPaths.js'`.
   - `assertPathInsideAllowedRoots` removed from `lib/paths.js` entirely (no external consumer).
2. **containerManager**
   - `containerPaths.js` (private, inside containerManager) refactored to take `containersPath` from a configure-time slot — no more `getConfigSync()` import. Adds a sync `resolveMount(id)` slot.
   - Linux + darwin facades expose `configure({ containersPath, resolveMount })`.
   - 4 internal files (`Create`, `Config`, `MountCrud`, `Backup`) switched from `getRawMounts()` (settings.js) to per-id `resolveMount()` lookup. Helper signatures (`validateAndNormalizeMounts`, `resolveMountHostPath`, `assertBindSourcesReady`, `buildOCISpec`) changed to take `resolveMount` callback instead of `storageMounts` array.
   - `lib/atomicJson.js` **vendored** into `lib/linux/containerManager/atomicJson.js` — manager owns its own copy. `containerManagerImages.js` and `containerManagerConfigIo.js` import the vendored copy.
   - `oci-image-meta.json` relocated from `dirname(CONFIG_PATH)/oci-image-meta.json` to `<containersPath>/.oci-image-meta.json`. Drops the last `CONFIG_PATH` import.
3. **Boot wiring** (`backend/src/index.js`)
   - Right after `loadRuntimeEnv`, call `configureVmManager(...)` and `configureContainerManager(...)` with values pulled from `getConfigSync()`.
   - `resolveMount` is a sync closure over `getConfigSync().mounts` — matches the per-call sync pattern paths.js used.
4. **`lib/paths.js`** — narrowed. Now only exports `getVMBasePath`, `getImagePath`, `ensureImageDir` for non-manager consumers (cloudInit, downloads, routes/library). No `assertPathInsideAllowedRoots`, no `routeErrors` import.

### What's NOT in this step

- **No folder reorg.** vmManager + containerManager stay at `lib/{linux,darwin}/<manager>/`. The eventual `lib/<manager>/{linux,darwin}/` normalization is part of the separate library-extraction effort.
- **No grouping into `lib/wispConfig/`.** `paths.js`, `config.js`, `settings.js`, `atomicJson.js`, `loadRuntimeEnv.js`, `bootCleanup.js` stay flat at `lib/`. The leak that mattered is *manager → policy*; push fixes that. Grouping flat files would have been churn for organizational cleanup with no functional gain (per decision below).

### Done when

- `grep -rE "from ['\"]\.\.(/\.\.)?/(paths|config|settings|atomicJson)\.js" backend/src/lib/{linux,darwin}/{vmManager,containerManager}` returns nothing. ✓
- Both managers' linux + darwin facades export `configure(cfg)`. ✓
- Boot smoke: imports + configure() succeed on darwin (real impl) and on linux/* facades imported directly. ✓

---

## Step 6 — Manager independence, leftovers grouping

### Outcome

After this step:

- **`vmManager` and `containerManager` import zero Wisp app glue.** Their only outside imports are stdlib + the cross-cutting carved modules (`mdns/`, `networking/`, `storage/`) + their own `vmManagerShared.js`. Going forward they are modified only when the change is generic (libvirt/containerd functionality), never for Wisp-specific concerns.
- **Other carved modules (`host/`, `networking/`, `mdns/`, `storage/`) stay looser** — they may reach into `routeErrors.js` for `createAppError` since they're cross-cutting Wisp-internal modules, not earmarked for extraction as standalone libs.
- **`lib/jobs/` and `lib/downloads/`** group two clusters of flat files that share an obvious purpose.
- The strict-managers rule is documented in `WISP-RULES.md` so future devs preserve the boundary.

### Goal scope (manager → wisp-glue edges that break)

Pre-step grep finds five edges from `vmManager`/`containerManager` into Wisp glue. All five break in this step:

| Edge | Source files | Action |
|------|--------------|--------|
| **A1** `routeErrors.js` (`createAppError`) | `vmManagerShared.js`, `linux/containerManager/containerManagerConnection.js`, `darwin/containerManager/index.js` | Inline the 4-line factory body into `vmError` and `containerError`. Drop the imports. |
| **A2** `validation.js` (`validateVMName`, `validateSnapshotName`, `validateContainerName`) | `vmManagerCreate.js`, `vmManagerConfig.js`, `vmManagerSnapshots.js`, `containerManagerBackup.js`, `containerManagerRename.js` | Vendor private copies into each manager (`vmManagerValidation.js`, `containerValidation.js`). Routes keep using `lib/validation.js` unchanged. Two implementations is fine — the validators are simple regexes and contracts won't drift. |
| **A3** `cloudInit.js` (file ops) — and the entire `vmManagerCloudInit.js` orchestrator | `vmManagerCreate.js` (`generateCloudInit`/`deleteCloudInitISO`), `vmManagerCloudInit.js` (5 imports) | Generalize `vmManager.attachISO` with `{ createIfMissing: true }` and `vmManager.ejectISO` with `{ removeSlot: true }` so cloud-init's slot-create / slot-remove cases ride the public ISO primitives. Move `vmManagerCloudInit.js` out of vmManager and merge into `lib/cloudInit.js` (Wisp glue now owns the orchestrator). Move the create-time `generateCloudInit` + rollback `deleteCloudInitISO` calls from `vmManagerCreate.js` to `routes/vms.js` POST handler. |
| **A4** `vmMdnsPublisher.js` (`publishVm`/`unpublishVm`) | `vmManagerConfig.js:329-333` | Drop the imperative call from the manager. The vmMdnsPublisher already subscribes to DomainEvent, but flipping `localDns` doesn't fire one (it's a metadata-only change). Move the conditional `publishVm`/`unpublishVm` to `routes/vms.js` PATCH `/vms/:name` after `updateVMConfig` succeeds. |
| **A5** `sections.js` (`renameWorkloadAssignment`) | `containerManagerRename.js:22, 224` | Move the best-effort rename to `routes/containers.js` PATCH `/containers/:name` after `renameContainer` succeeds. |

After A1–A5, this grep returns nothing:

```
grep -rE "from ['\"][^'\"]*\.\./?(routeErrors|validation|cloudInit|vmMdnsPublisher|sections)\.js" \
  backend/src/lib/{linux,darwin}/{vmManager,containerManager}
```

### Out of scope for this step

- **`vmManager` → `mdns/`, `networking/`, `storage/`**: kept. These are carved cross-cutting modules, not Wisp policy. (mDNS publishing *policy* — what to publish, when — lives in `vmMdnsPublisher.js` glue, which is broken from manager via A4.)
- **`vmManagerShared.js`** stays at `lib/` top-level. After A1 it's pure helpers (no policy imports). The library-extraction effort moves it inside the manager tree later.
- **Per-module `errors.js` factories** — step 4's note suggested splitting codes per module; rejected for this step. One shared `errorCodeToStatus` in `routeErrors.js` is fine; the leak that mattered (manager → that file) is broken by A1.

### B — `routeErrors.js` final shape

Keep `lib/routeErrors.js` filename and location. After A1, no manager touches it. Non-manager modules (`host/`, `networking/`, `storage/`, `mdns/`, downloads, app-glue, routes) keep importing `createAppError` from there. The translator side (`handleRouteError`, `sendError`, `errorCodeToStatus`, `curateDetail`) remains route-side only.

No moves; just verify and document.

### C — group `lib/jobs/`

Move 9 flat job files into `lib/jobs/` with an `index.js` facade.

```
backend/src/lib/jobs/
  index.js                  # re-exports
  jobStore.js               # generic in-memory store
  backgroundJobKinds.js     # constants
  backgroundJobTitles.js    # title helpers
  listBackgroundJobs.js     # cross-area list aggregator
  backupJobStore.js
  containerJobStore.js
  createJobStore.js
  downloadJobStore.js
  imageUpdateJobStore.js
```

Re-grep all consumers and rewrite import paths.

### D — group `lib/downloads/`

Move 6 flat download files into `lib/downloads/` with an `index.js` facade.

```
backend/src/lib/downloads/
  index.js
  downloadFromUrl.js
  downloadUtils.js
  downloadArchCloud.js
  downloadHaos.js
  downloadUbuntuCloud.js
  fileTypes.js
```

Primary consumer is `routes/library.js`; verify others.

### E — document the strict-managers rule

Add to `docs/WISP-RULES.md` (and a brief pointer in root `CLAUDE.md` + `lib/CLAUDE.md`):

> **vmManager and containerManager are strict.** They must not import any Wisp app glue (`routeErrors`, `validation`, `cloudInit`, `vmMdnsPublisher`, `sections`, `paths`, `config`, `settings`, `atomicJson`, `loadRuntimeEnv`, `bootCleanup`, `mountsAutoMount`, job stores, downloads). They may import only stdlib, their own internal files, `vmManagerShared.js`, and the carved cross-cutting modules `mdns/`, `networking/`, `storage/`. Future changes to vmManager or containerManager are appropriate only for generic libvirt/containerd functionality. Wisp-specific orchestration goes in routes or app-glue files (which call into the managers via their public surface). Other carved modules (`host/`, `networking/`, `mdns/`, `storage/`) are looser — they may import `createAppError` from `routeErrors.js`.

### Done when

- Manager-edge greps return nothing (A1–A5).
- `vmManagerCloudInit.js` no longer exists inside the manager tree; `lib/cloudInit.js` exposes the cloud-init orchestrator surface (`generateCloudInit`, `attachCloudInitDisk`, `detachCloudInitDisk`, `getCloudInitConfig`, `updateCloudInit`).
- `vmManager.attachISO` / `ejectISO` accept the new option flags; cloud-init's create-slot path rides the generalized primitive.
- `routes/vms.js` POST creates cloud-init artifacts before `createVM` and cleans up on failure.
- `routes/vms.js` PATCH calls `publishVm`/`unpublishVm` based on the body patch.
- `routes/containers.js` PATCH calls `renameWorkloadAssignment` after rename.
- `lib/jobs/` and `lib/downloads/` exist; old flat files removed; consumers updated.
- `docs/WISP-RULES.md` carries the strict-managers rule. `CLAUDE.md`, `lib/CLAUDE.md` updated.
- Backend boots; PATCH a VM `localDns` toggle still publishes/unpublishes; rename a container still moves its section assignment; create a VM with cloud-init still works; update a VM's cloud-init config still works.
- Three commits: (1) A1–A5 + E, (2) `lib/jobs/`, (3) `lib/downloads/`. CHANGELOG updated.

### Open questions for execution

- **A3 attachISO/ejectISO option shape**: confirmed during execution that `{ createIfMissing: true }` and `{ removeSlot: true }` are the right knobs (vs. separate primitives like `installCDROMSlot` / `removeCDROMSlot`). The opts approach reuses the existing exports; new primitive names would have grown the public surface for one caller.
- **A4 PATCH semantics**: `updateVMConfig` already returns `{ ok, requiresRestart }`. Route reads `body.localDns` after the call to decide publish/unpublish. Verify nothing in `updateVMConfig`'s internal flow relies on the publish call landing before the function returns.
- **A5 ordering**: rename succeeds → call sections rename. If sections rename throws, log + continue (best-effort, matches current behavior).

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
- 2026-05-04 — [step 5] — Skipped the `lib/wispConfig/` folder reorg the original step-5 sketch implied. Reason: the leak that blocks library extraction is *manager → policy import*, not *flat policy files*. Push-via-configure() kills the import edge regardless of where the policy files live. Moving `paths.js`/`config.js`/`settings.js` into a folder would have been ~30 import-path rewrites in routes + app-glue for organizational tidiness only. Step 5 ended up much smaller than sketched: just `configure()` + helper file + ~12 import rewrites inside the managers.
- 2026-05-04 — [step 5] — `assertPathInsideAllowedRoots` moved fully into vmManager (private `vmManagerPaths.js`), removed from `lib/paths.js`. Reason: only consumer was vmManager; the function is defense-in-depth security right before DBus `UpdateDevice` (vmManager's responsibility) parameterized by the two roots (Wisp policy data). Push the data, own the gate. Switched its error factory from `createAppError` to vmManager's `vmError` for consistency with the rest of the manager.
- 2026-05-04 — [step 5] — `oci-image-meta.json` relocated from `dirname(CONFIG_PATH)/oci-image-meta.json` to `<containersPath>/.oci-image-meta.json`. Reason: the file is a containerManager-private cache (image-pull-timestamp pinning), not Wisp app config. Original "lives next to wisp-config.json" placement was for a stable host dir; `containersPath` is the natural home now that containerManager owns it after configure(). Cache-only — code returns `{}` if missing, rebuilds on next pull. Existing installs orphan the old few-KB file (acceptable per feature-building mode: no migration; missing cache rebuilds on first pull).
- 2026-05-04 — [step 5] — `atomicJson.js` vendored into containerManager (`lib/linux/containerManager/atomicJson.js`) instead of staying as a shared import. Reason: `writeJsonAtomic` is consumed by both Wisp glue (settings.js, bootCleanup.js) and containerManager (container.json, oci-image-meta.json) — vmManager doesn't use it (libvirt persists XML). Vendoring means containerManager has zero non-stdlib lib-glue imports (cleaner extraction surface). Tmp-suffix regex matches the source file, so bootCleanup's janitor still finds tmp leftovers in the containers dir even though containerManager wrote them with its private copy. Cost: ~40 lines duplicated; benefit: containerManager's import graph is one step closer to self-contained.
- 2026-05-04 — [step 5] — `resolveMount(id)` callback is **sync**, returning `null | { id, mountPath, label? }`. Reason: existing callers (`validateAndNormalizeMounts`, `resolveMountHostPath`, `buildOCISpec`) are synchronous helpers used inside async loops; an async resolver would have cascaded into making them all async. Wisp's resolver implementation is `getConfigSync().mounts.find(...)` — same per-call file-read pattern that `paths.js` used (small JSON, OS-cached). Per-mount-entry disk hits are negligible.
- 2026-05-04 — [step 5] — Boot smoke: validated by importing the linux facades directly (`lib/linux/{vmManager,containerManager}/index.js`) and calling `configure()` — no TLA cycles, no init-order issues. Step 1's "verify with the facade entry point" lesson applied; this time it passed clean on first try because there are no static cross-imports between the new helper files and any other manager-internal file (vmManagerPaths only depends on `vmManagerShared`; containerPaths has no manager imports).
- 2026-05-04 — [step 5 follow-up] — `assertPathInsideAllowedRoots` and the library-relative path resolution moved BACK into Wisp glue (`lib/paths.js`) — initial step-5 design pulled them into vmManager-private as "defense-in-depth at the libvirt boundary," but the user pushed back that the function is API-input validation against Wisp policy roots, not a libvirt operation. Routes (`POST /vms`, `POST /vms/:name/disks`, `POST /vms/:name/cdrom/:slot`) now call `resolveLibraryPath(p)` + `assertPathInsideAllowedRoots(abs, vmName)` before handing absolute paths to vmManager. vmManager.configure() drops `imagePath` and only takes `{ vmsPath }`. vmManagerPaths.js shrinks to `getVMBasePath` + `getVmsPath`. End state is cleaner: vmManager is policy-agnostic about which host paths are "allowed" (a reusable lib has no opinion on this); Wisp owns its security policy in one place (`paths.js`). Re-verified live: PATH_NOT_ALLOWED still returns 422 with the exact error shape (smoke tested via DevTools fetch on the deployed instance).
- 2026-05-04 — [step 6] — Strict-managers rule: vmManager + containerManager forbidden from importing any Wisp app glue (routeErrors/validation/cloudInit/vmMdnsPublisher/sections/paths/config/settings/atomicJson/etc.). Other carved modules (host/networking/mdns/storage) explicitly looser. Codified in `docs/WISP-RULES.md` § Architecture and pinned in root `CLAUDE.md` so future developers preserve the boundary. The user's stated goal: vmManager and containerManager become "fully independent entities within the app source code" and only get touched for generic libvirt/containerd functionality, never for Wisp-specific features.
- 2026-05-04 — [step 6] — `createAppError` factory inlined directly into `vmError`/`containerError` (4 lines each) rather than vendored into a manager-private file. Reason: the body is trivial; vendoring as a separate file would have added file count without functional benefit. The two managers each declare their own error factory inline.
- 2026-05-04 — [step 6] — Validators vendored as private files inside each manager (`vmManagerValidation.js` with `validateVMName` + `validateSnapshotName`, `containerValidation.js` with `validateContainerName`) rather than dropped from manager-side validation. Reason: defense-in-depth is intentional in this codebase (manager validates after route validates), and a vendored copy is the extraction-mode-correct choice — two implementations of a simple regex contract are unlikely to drift, and keeping the validators inside each manager means the manager remains independently extractable. Routes continue to use `lib/validation.js` directly.
- 2026-05-04 — [step 6] — Cloud-init was the largest manager → Wisp-glue edge: `vmManagerCloudInit.js` (200 lines) was a Wisp-glue orchestrator misfiled inside the manager tree, importing 5 functions from `lib/cloudInit.js`. Resolved by **deleting `vmManagerCloudInit.js`** entirely and merging the orchestrator into `lib/cloudInit.js`. To support this without exposing libvirt internals, `vmManager.attachISO` was generalized with `{ createIfMissing: true }` (covers cloud-init's first-enable case where the sde slot doesn't exist yet) and `vmManager.ejectISO` with `{ removeSlot: true }` (covers detach's offline-remove-device case). cloud-init now rides public ISO primitives. Rationale: the slot-creation logic was the only "cloud-init-specific" thing inside vmManager — pulling it into a generic option means the manager keeps a clean "attach ISO to slot" interface that other CDROM use cases could also benefit from. Create-time `generateCloudInit` + rollback `deleteCloudInitISO` moved from `vmManagerCreate.js` to `routes/vms.js` POST handler. `vmManager.parseVMFromXML` newly exported (cloudInit.js needs it for first-NIC MAC lookup at post-create regenerate time).
- 2026-05-04 — [step 6] — `publishVm`/`unpublishVm` calls in `vmManagerConfig.js` (the only manager → vmMdnsPublisher edge) moved to `routes/vms.js` PATCH handler. **Architecture finding** (worth recording for future sessions): the manager event surface was already correct — `vmManagerConnection.js` exposes `subscribeDomainChange` / `subscribeAgentEvent` / `subscribeDisconnect`, and `vmMdnsPublisher.js` already subscribes to all three to drive its reconcile. The imperative call only existed because flipping the `localDns` Wisp metadata field doesn't fire a libvirt DomainEvent (no domain XML change). Rather than adding a new manager event surface for metadata changes (Option 2) or hacking a synthetic DomainEvent (Option 1), we picked Option 3: the route is the orchestrator. Route does `vmManager.updateVMConfig(...)` then conditionally calls `vmMdnsPublisher.publishVm(...)` / `unpublishVm(...)` based on `body.localDns`. Same pattern as A3 and A5: managers do their thing, app glue does its thing, the route stitches them.
- 2026-05-04 — [step 6] — `renameWorkloadAssignment` call moved from `containerManagerRename.js` to `routes/containers.js` PATCH handler. Steps in containerManagerRename collapsed from 9 to 8 (sections-rename was step 7).
- 2026-05-04 — [step 6] — Decided **not** to split codes per module (per-module `errors.js` factories with their own subset of `errorCodeToStatus`). The shared `errorCodeToStatus` switch in `routeErrors.js` is fine because: managers no longer import it (A1 inline); other modules and routes share one switch which is simpler to maintain. The leak that mattered (manager → file with the 80-code switch) is broken; further factoring would have been organizational churn for no functional gain.
- 2026-05-04 — [step 6] — `lib/jobs/` and `lib/downloads/` grouped behind facade modules. `validation.js`, `routeErrors.js`, and the Wisp-config / app-glue files (paths/config/settings/atomicJson/auth/cookies/sse/etc.) intentionally kept flat — these are Wisp-specific app concerns that won't be extracted as standalone libraries; keeping them flat avoids gratuitous folder reshuffling.
