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

- **Current step:** Step 3 — Storage primitives (sketched, needs detailing)
- **Completed:** Step 1 — Networking & Bridges (2026-05-03), Step 2 — mDNS (2026-05-03)

## Boundaries identified (overview)

These are the internal modules to carve out of the flat `backend/src/lib/` surface, in execution order. Order is driven by which leaks block the "two independent libs" goal most directly.

| # | Module | Why first/last | Status |
|---|--------|----------------|--------|
| 1 | **Networking & bridges** | Only true cross-leak: `containerManager` imports from `vmManager`. Unblocking this means the two managers become independent. | done |
| 2 | **mDNS** | Both managers and several other modules reach into mDNS directly. Group under one named module. | done |
| 3 | **Storage primitives** | `diskOps`, `smbMount`, `diskMount` — generic disk operations, currently flat. | sketched |
| 4 | **Host introspection** | `hostHardware`, `hostGpus`, `usbMonitor`, proc readers. Already partially under `linux/host/`. | sketched |
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

## Step 4 — Host introspection  *(sketched)*

**Files in scope:** `hostHardware.js`, `hostGpus.js`, `hostPower.js`, `usbMonitor.js`, `procStats.js`, `rebootRequired.js`, `linux/host/*` files not already moved by earlier steps.

**Note:** `linux/host/` already exists. Step 4 likely just consolidates the top-level `host*.js` files into the existing `host/` structure and adds a facade.

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
