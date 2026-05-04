# Managers — Network Events & Platform Layout

Follow-up campaign to `modules-boundaries.md`. Two related cleanups, executed in three commits.

## Goal

1. Replace the libvirt-internal reach-through in `vmMdnsPublisher` with a public, platform-agnostic event surface on `vmManager` (`subscribeVMNetworkChange`). Do the parallel cleanup on the container side.
2. Move the manager platform impls from `lib/{linux,darwin}/{vmManager,containerManager}/` into `lib/{vmManager,containerManager}/{linux,darwin}/`, matching every other named module in `lib/` (`mdns/`, `networking/`, `storage/`, `host/`).

After this campaign, the only thing left in `lib/linux/` and `lib/darwin/` is nothing — both directories are deleted.

## Non-goals

- No npm-package extraction.
- No changes to UI or API contracts (the per-VM stats SSE keeps polling for now — using the new event there is a follow-up, not part of this work).
- No backwards-compatibility shims — feature-building mode. All call sites updated in the same commit as the rename.

## Status

- **Current step:** None — campaign complete.
- **Completed:** Step 1 (2026-05-04), Step 2 (2026-05-04), Step 3 (2026-05-04).

## Steps overview

| # | Title | Why | Commit |
|---|-------|-----|--------|
| 1 | VM network event + flatten `vmMdnsReconciler` | Eliminates publisher's libvirt-internal imports; same-shape glue as the container side. Renames publisher → reconciler for parallel naming. | one |
| 2 | Container network event + flatten `containerMdnsReconciler` | Same shape on the container side. Also fixes inverted ownership: today the reconciler writes `container.json` on behalf of containerManager. | one |
| 3 | Manager directory layout | `lib/linux/{vm,container}Manager` → `lib/{vm,container}Manager/linux`, etc. Mechanical rename now that the platform-split publisher is gone. | one |

---

## Step 1 — VM network-change event + flatten `vmMdnsReconciler`

### Why

`lib/linux/vmMdnsPublisher.js` imports five private libvirt subscription helpers from `vmManager` (`subscribeDomainChange`, `subscribeAgentEvent`, `subscribeDisconnect`, `attachAgentSubscription`, `detachAgentSubscription`) plus `getGuestNetwork`. None of those except `getGuestNetwork` are on the public facade. That's a glue→manager-internals reach-through that platform-splits the publisher even though "register a VM IP in mDNS" is platform-agnostic policy.

If `vmManager` exposes `subscribeVMNetworkChange((name, snapshot) => {...})`, the publisher (renamed `vmMdnsReconciler`) collapses to a single flat file — same shape as `containerMdnsReconciler.js` already has.

### New public surface on `vmManager`

```js
vmManager.subscribeVMNetworkChange(handler);
// handler(name, snapshot) where:
//   snapshot = { stateCode, ip, hostname }   when running
//   snapshot = null                          when stopped/undefined
// returns: unsubscribe function
```

Fires when **any** of `stateCode`, `ip`, `hostname` differs from the last emitted snapshot for that VM. No event when the snapshot is unchanged.

### Linux impl behavior

In a new `lib/linux/vmManager/vmManagerNetwork.js` (or folded into `vmManagerConnection.js` — pick at implementation time):

- Maintain `Map<name, snapshot>` of last-emitted snapshots.
- On every `DomainEvent`: for each affected VM (or all running VMs on lifecycle changes), probe via existing `getGuestNetwork(name)`, diff, fire on change. On transitions out of running state, emit `null` and drop from map.
- Auto-attach `AgentEvent` listeners for all running VMs (replacing the publisher's manual `attachAgentSubscription`/`detachAgentSubscription` calls). On `AgentEvent` connect: probe that VM, diff, fire.
- 60-second periodic timer: probe each running VM, diff, fire on change. Catches DHCP drift / missed signals (same role as today's 45s safety net in the publisher; cadence aligned with container reconciler).
- On libvirt disconnect: clear the snapshot map. Post-reconnect, the existing `fireDomainChange()` triggers a fresh round of probes.

### Darwin impl behavior

`subscribeVMNetworkChange` returns a no-op unsubscribe; never fires.

### Glue: rename + flatten

- Delete `lib/linux/vmMdnsPublisher.js` and `lib/darwin/vmMdnsPublisher.js`.
- Rename `lib/vmMdnsPublisher.js` → `lib/vmMdnsReconciler.js`. Rewrite as a single flat file that:
  - Subscribes to `vmManager.subscribeVMNetworkChange` at start.
  - Maintains `Set<name>` of VMs we've registered with mDNS.
  - On event: read `localDns` from the cached config (`vmManager.getCachedLocalDns(name)`), register/deregister via `mdns/` module accordingly.
  - Exports `startVmMdnsReconciler(log)` / `stopVmMdnsReconciler()` for boot wiring.
  - Exports `publishVm(name)` / `unpublishVm(name)` for routes (toggle, rename) — both are imperative wrappers that read the current snapshot via `vmManager.getGuestNetwork` and register/deregister directly.

### Call sites to update

- `backend/src/index.js`: import path + start/stop function name.
- `backend/src/routes/vms.js`: import path stays the same module-style call but file is renamed.
- `backend/src/lib/CLAUDE.md`, `docs/WISP-RULES.md`, `docs/ARCHITECTURE.md`, `docs/spec/VM-MANAGEMENT.md`: rename mentions, update strict-managers rule list (`vmMdnsPublisher` → `vmMdnsReconciler`).
- Inline doc comments in `vmManagerStats.js`, `vmManagerConnection.js`, `vmManagerConfig.js`.

### Verification

- Boot the dev backend; confirm logs say "VM mDNS reconciler started" or similar.
- With a VM that has `localDns: true` and qemu-ga running, confirm an mDNS A record gets registered via `avahi-browse -art | grep <vm>` (or check the SSE stats from the UI for `mdnsHostname`).
- Toggle `localDns` off via the UI, confirm the record goes away. Toggle on, confirm it returns.
- Stop the VM, confirm the record is removed (lifecycle event → null snapshot → reconciler deregisters).

---

## Step 2 — Container network-change event + flatten `containerMdnsReconciler`

### Why

Today `containerMdnsReconciler` does three things in its 60s tick:
1. Probe IP via `containerManager.discoverIpv4InNetnsOnce`
2. **Persist new IP to `container.json`** via `containerManager.writeContainerConfig` — inverted ownership; the reconciler writes a file owned by containerManager.
3. Re-register mDNS A record.

(2) is the leak. Move the probe + persistence into `containerManager` itself, fire `subscribeContainerNetworkChange`, and the reconciler shrinks to "subscribe, register on event."

### New public surface on `containerManager`

```js
containerManager.subscribeContainerNetworkChange(handler);
// handler(name, snapshot) where:
//   snapshot = { state, ip }   when running
//   snapshot = null             when stopped/removed
// returns: unsubscribe function
```

Same shape as the VM event for uniformity. `state` here is the containerd task state (`'running'`, `'stopped'`, etc.) — match the existing `containerEntry.state` field.

### Linux impl behavior

In a new file under `lib/linux/containerManager/` (e.g. `containerManagerNetworkPoller.js`):

- 60s periodic timer.
- For each running container with `network.type === 'bridge'`: probe `discoverIpv4InNetnsOnce(name, 'eth0')`. If IP differs from `network.ip` in `container.json`, persist via `writeContainerConfig`, then fire the event.
- Track last-emitted snapshot per container; fire only on diff.
- On container stop / delete (detected via `subscribeContainerListChange` or by absence in next listContainers tick): emit `null`, drop from map.

### Darwin impl behavior

No-op; `subscribeContainerNetworkChange` returns a no-op unsubscribe.

### Glue: flatten

- Rewrite `lib/containerMdnsReconciler.js` as a subscriber-only file:
  - Subscribes to `containerManager.subscribeContainerNetworkChange` at start.
  - On event: read `localDns` via `getContainerConfig`, register/deregister via `mdns/`.
  - No own polling, no own `writeContainerConfig`.
- Keep `startContainerMdnsReconciler` / `stopContainerMdnsReconciler` exports.

### Call sites to update

- `backend/src/index.js`: no changes (start/stop function names are the same).
- Inline doc comments referencing the old polling shape.
- `docs/spec/CONTAINERS.md`, `docs/ARCHITECTURE.md`.

### Verification

- Container with `localDns: true`, bridge network: confirm mDNS A record registered.
- Force a DHCP renewal in the netns (or restart the container) and confirm `container.json`'s `network.ip` updates and the mDNS record refreshes within 60s.

---

## Step 3 — Manager directory layout

### Why

After steps 1 + 2, `lib/linux/` and `lib/darwin/` contain only the `vmManager/` and `containerManager/` subdirs. Move each manager into its own self-contained module folder, matching every other named lib module:

```
lib/vmManager/
  index.js              (was lib/vmManager.js)
  vmManagerShared.js    (was lib/vmManagerShared.js — only vmManager imports it)
  linux/                (was lib/linux/vmManager/)
    index.js
    vmManagerConnection.js
    ...etc
  darwin/               (was lib/darwin/vmManager/)
    index.js

lib/containerManager/
  index.js              (was lib/containerManager.js)
  linux/                (was lib/linux/containerManager/)
    index.js
    ...etc
  darwin/               (was lib/darwin/containerManager/)
    index.js
```

Then delete the empty `lib/linux/` and `lib/darwin/`.

### Mechanical rules

- Pure rename + import-path update. No behavior changes.
- Update relative import paths in every moved file (most go from `../../foo` to `../../foo` since depth is the same; some shift). Verify with grep after the move.
- `vmManagerShared.js` moves *into* `lib/vmManager/`. Its two consumers (`linux/vmManagerConnection.js`, `linux/vmManagerValidation.js`, `darwin/index.js`) update their imports from `../../vmManagerShared.js` to `../vmManagerShared.js`.
- The darwin → linux internal reach (`darwin/vmManager/index.js` imports from `linux/vmManager/vmManagerXml.js`; `darwin/containerManager/index.js` imports from `linux/containerManager/containerPaths.js` + `containerManagerSpec.js`) becomes `../linux/...` after the move. Same code share, shorter path.

### Doc updates (same commit)

- `CLAUDE.md` — strict-managers rule path mentions
- `backend/src/lib/CLAUDE.md` — vmManager rules section, configure() boot wiring paths
- `docs/WISP-RULES.md` — Architecture section path mentions
- `docs/ARCHITECTURE.md` — module map
- `docs/spec/VM-MANAGEMENT.md`
- `docs/spec/CONTAINERS.md`
- `docs/plans/modules-boundaries.md` — add a "post-campaign followup" note pointing here

### Verification

- `grep -rn "lib/linux/vmManager\|lib/darwin/vmManager\|lib/linux/containerManager\|lib/darwin/containerManager" backend src docs` returns nothing.
- Boot the dev backend on macOS (darwin path) — confirms darwin stub still resolves correctly through the moved layout.
- Run a full create/start/stop/delete VM cycle and a container cycle on the linux server.

---

## Decisions log

- **2026-05-04** — `vmMdnsPublisher` renamed to `vmMdnsReconciler` for parallel naming with `containerMdnsReconciler`. Both pieces of glue do the same thing (reconcile mDNS records to current state), no reason to call one "publisher."
- **2026-05-04** — Reconciler periodic cadence aligned at 60s for VM and container. Was 45s for VM. The libvirt event hooks (`DomainEvent`, `AgentEvent`) make the periodic mostly redundant for VMs; 60s is fine as a DHCP-drift safety net.
- **2026-05-04** — Container network probe + `container.json` IP persistence move into `containerManager` (was in glue). Fixes inverted ownership.
- **2026-05-04** — Network-change events probe **all** running VMs / bridge containers, not just those with `localDns: true`. The `localDns` filter is a glue concern (the reconciler), not a manager concern. N is small enough that the cost is negligible, and event consumers other than mDNS may emerge.
- **2026-05-04** — Auto-attach `AgentEvent` subscriptions for all running VMs from inside vmManager (replaces the publisher's manual attach/detach). Slightly more proactive than today (attaches even if no `subscribeVMNetworkChange` subscriber), but harmless and much simpler.
