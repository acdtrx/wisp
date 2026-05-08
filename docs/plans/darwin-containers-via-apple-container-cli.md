# Darwin Containers via Apple's `container` CLI

Status: **plan only — not implemented**. This document scopes a future Darwin implementation of the containerManager facade using Apple's official `container` CLI as the runtime backend. It exists so we can revisit the design before committing to it; nothing here has been built.

## 1. Goal and non‑goals

**Goal.** Make the Containers tab functional on macOS, so the same Wisp UI used on Linux can:

- Pull OCI images from public registries.
- Create, start, stop, restart, kill, and delete containers.
- View live state and resource stats.
- Edit configuration (image, env, mounts, command, CPU/memory limits, restart policy, autostart, icon).
- Tail per‑run logs and replay completed runs.
- Open an interactive shell into a running container.
- Expose container services to **other machines on the LAN** through host port publishing.

**Explicit non‑goals.**

- Per‑container LAN IPs and direct LAN reachability — `container` puts every container behind vmnet (`192.168.64.0/24`), routable from the macOS host but **not** from other LAN machines. This is an architectural property of Apple's stack and there is no workaround without bridged‑vmnet entitlements that Apple does not grant to self‑hosted apps.
- VMs on Darwin — covered by the parallel analysis; out of scope here.
- `runAsRoot` + idmapped Local mounts — these are Linux‑kernel features. On Darwin the container process runs as whatever UID the image specifies; host file ownership is handled by `container`'s virtio‑fs style sharing.
- Host device passthrough (`devices[]`, GPU) — Linux DRM render nodes don't exist on macOS.
- VLAN sub‑bridges, CNI customisation, custom bridge MACs — `container`'s networking model doesn't expose these.
- `.local` per‑container A‑records pointing at per‑container IPs — see § 5 for the replacement model.

The high bar is **functional parity for "I want to run a Linux service container on my Mac and reach it from elsewhere on my LAN"**, not byte‑for‑byte parity with the Linux backend.

## 2. Environment and requirements

- **macOS 26+** (Apple Silicon). Apple's docs are explicit that macOS 15 issues that don't reproduce on macOS 26 will not be fixed; we should refuse to start the Darwin backend on macOS < 26 with a clear error.
- **`container` installed.** Distributed as a signed installer pkg from `github.com/apple/container/releases`. We do **not** ship it — Wisp's installer (today: `scripts/install.sh`, Linux‑only) gets a Darwin equivalent that:
  - Verifies `/usr/local/bin/container` exists and the version is supported (parsed from `container --version` or `container system version --format json`).
  - Runs `container system start` (idempotent — it activates the launch agent that runs `container-apiserver`).
  - Optionally prompts to install the recommended kernel via `container system kernel set --recommended`.
- **Bonjour / dns‑sd** is part of macOS — no install step. Used in § 5.
- **No sudo required for normal operation.** `container system dns create` requires sudo, but that command isn't in our default flow.
- **Path layout.** `getContainersPath()` resolves to `~/Library/Application Support/Wisp/containers` on Darwin (today this is `/var/lib/wisp/containers` on Linux). The change is **only in `paths.js`** (Wisp‑glue), not in the manager — `containerManager.configure({ containersPath })` already takes the path as input.

## 3. Networking model — the central architectural shift

This is the most important read of the whole document. Everything else falls out of it.

### Linux (today)
Each container is a veth port on a host Linux bridge (`br0`). The container gets a real LAN DHCP lease (e.g. `192.168.1.50`), reachable from any machine on the LAN. mDNS publishes `<name>.local` → that IP. There is no port‑publishing concept — services are reachable on whatever ports the container listens on, at the container's own IP.

### Darwin (proposed)
Each container is a lightweight VM behind `vmnet`. Apple's `container-network-vmnet` daemon owns the `192.168.64.0/24` subnet (or whatever `container` decides on macOS 26 — see § 13). Container IPs are routable **from the macOS host** but **not from other LAN machines**. The standard model is Docker‑Desktop‑style: publish container ports on the host with `-p <host-port>:<container-port>`, then reach them at `<mac-host-ip>:<host-port>` (or `<mac-host>.local:<host-port>` via Bonjour, since macOS already publishes its own hostname).

Concretely, this means a Wisp Darwin container with `network.type: bridge` (preserved as the only supported value) actually runs with:

- An automatic vmnet attachment (`container run` defaults).
- Zero or more **published ports** declared in `container.json` and passed as `--publish` flags on `container run`.

`container.json` gains a `publishedPorts: [{ hostPort, containerPort, protocol, hostInterface? }]` array on Darwin (it's also harmless on Linux, where it's just ignored — the spec doc gets a "Linux: ignored, containers are on the LAN" callout). The frontend's Network section grows a Published Ports table when running on Darwin (or, depending on the future of the project, always — the Linux ignore is cheap).

### Why not work around the LAN constraint?

We considered:

- **Bridged vmnet** — requires `com.apple.vm.networking` entitlement, granted by Apple. Not realistic for a self‑distributed app.
- **macOS routing tricks** (`pf` rules to NAT vmnet onto the LAN) — fragile, breaks Private Relay, and Apple's own docs warn that DNS‑level workarounds are unstable on macOS 26.
- **Bonjour proxy A‑records** (`dns-sd -P <name>.local <vmnet-ip>`) — registers fine, but the IP isn't reachable from outside the Mac. So clients that resolve `homepage.local` would fail to connect from another machine. Worse than the port‑publishing UX.

Verdict: stop trying. **Containers on Darwin live behind the host's IP. Period.** The whole UX downstream of this — the Network section, the mDNS publishing, the docs — collapses to that contract.

## 4. Functional scope

| Feature | Status on Darwin | Notes |
|---|---|---|
| Pull OCI image from registry | ✅ | `container pull <ref>` (or `image pull`). Multi‑arch via `--platform`/`--arch`. |
| Local image library list | ✅ | `container images list --format json`. |
| Image delete | ✅ | `container images delete <ref>`. |
| Image update check | ✅ | Re‑pull and diff digests, same model as Linux. |
| Image build | ❌ deferred | `container build` exists but Wisp doesn't expose build today on Linux either. |
| Create container | ✅ | `container create` first, then `container start` from `startContainer`. |
| Start / stop / kill / restart / delete | ✅ | `container start/stop/kill/delete`. |
| Live state stream | ⚠ poll | No event subscription API in `container`. Poll `container ls --format json --all` every ~3 s, plus an immediate refresh after every state‑changing call. |
| Stats (CPU/mem/uptime) | ✅ | `container stats <name> --no-stream --format json`. No network bytes (acceptable). |
| Per‑run logs | ✅ | Tailer subprocess (`container logs -f`) writes to `runs/<runId>.log`; sidecar JSON same shape as Linux. |
| Live log SSE | ✅ | Re‑uses the existing `streamContainerRunLogs` file‑tail design — file‑based, platform‑independent. |
| Interactive console (exec) | ✅ phase 3 | `container exec -it <name> /bin/sh`. Needs `node-pty` or accepting non‑PTY mode for v1. PTY resize: not exposed by the CLI; the resize message becomes a no‑op on Darwin. |
| Env vars (incl. `secret`) | ✅ | `--env KEY=VALUE` per entry. Secret masking is purely a Wisp concern. |
| Mounts: Local | ✅ | `--volume <containersPath>/<name>/files/<mountName>:<containerPath>[:ro]`. |
| Mounts: Storage‑sourced | ✅ | Same flag, source resolves through `resolveMount(sourceId)`. Storage mounts on Darwin are SMB shares mounted via `mount_smbfs`. |
| Mounts: tmpfs | ❌ deferred | `container` doesn't seem to expose tmpfs flags. Either reject `type: "tmpfs"` on Darwin or emulate with `--tmpfs` if a future CLI version adds it. |
| `runAsRoot` + idmapped mounts | ❌ | Linux‑only kernel feature. On Darwin the field is silently ignored; document. |
| Devices (GPU passthrough) | ❌ | Reject any `devices[]` entry with `CONTAINER_DEVICE_NOT_SUPPORTED_ON_DARWIN` (422). |
| Restart policies | ✅ | `container run` has no `--restart`; Wisp implements all four policies (`never`, `on-failure`, `unless-stopped`, `always`) in the state poll loop. |
| Autostart at backend boot | ✅ | Same as Linux: list containers, start the autostart‑true ones. |
| Backups (tar.gz of container dir) | ✅ | Path layout differs but the tar logic is platform‑agnostic. |
| Image references | ✅ | `normalizeImageRef` is pure JS — reused as is. |
| Image local‑shortcut (`ctr -n wisp image import` parallel) | ⚠ partial | `container image load -i <tar>` is the analog. Plumbing the same "literal local ref → use as is" probe via `container image inspect` is straightforward. |
| Local DNS publishing (`<name>.local`) | ⚠ revised | A‑records dropped (see § 3). SRV/TXT services published via `dns-sd` against the **host's** name and the **published port**. Section § 5 is the spec. |
| Per‑container LAN IP | ❌ | Not achievable on Darwin without entitlements. |
| LAN reachability | ✅ via host | Reach via `<mac-host-ip>:<hostPort>` or `<mac-host>.local:<hostPort>`. |

## 5. mDNS / Bonjour on Darwin

The Linux behaviour is "publish `<container>.local` pointing at the container's LAN IP, plus optional SRV/TXT services on that name". On Darwin we **drop the per‑container A‑record** and publish services against the macOS host's own Bonjour name.

### Mechanics

- macOS already publishes `<host>.local` automatically (System Settings → Sharing → Local Hostname). We don't touch it.
- For each `services[]` entry on a running container with `localDns: true`, register an SRV+TXT via `dns-sd -R`:
  ```
  dns-sd -R <instanceName> <type>. local <hostPort> [<txt-key>=<value> ...]
  ```
  where `<instanceName>` is the container name (sanitised) and `<hostPort>` is the published host port for the relevant container port. The registration is implicitly bound to the host's own A‑record.
- `dns-sd -R` keeps the registration alive only while the process is running. So the implementation is a long‑lived child process per service, owned by `containerManager.darwin/`. On container stop or service removal, kill the child.
- An alternative is a single host‑lifetime helper that registers/deregisters via stdin commands — more complex but avoids dozens of child processes for users with many services. Phase‑1 keeps it simple: one child per service.

### Implications for the spec

- `services[].port` on Darwin means the **host port** (the published port), not the in‑container port. The frontend Service editor gets a tooltip and a label change ("Host port") on Darwin.
- `<container>.local` does **not** resolve from another LAN machine — a meaningful change from Linux. The User Manual / spec says: "On Darwin, services advertise on `<your-mac>.local` at the published port; container hostnames are not used."
- The reconciler (`containerMdnsReconciler.js`) is largely unchanged — it still subscribes to `subscribeContainerNetworkChange` and calls `registerService` / `deregisterService`. The platform difference is encapsulated in `mdns/darwin/`.

### Updates to `lib/mdns/darwin/avahi.js`

The current Darwin stub returns `null`/`false` for everything. Replace with a real implementation that:

- `registerService({ name, type, port, txt })` → spawns `dns-sd -R …`, stashes the child handle in a Map keyed by `${name}#${port}`.
- `deregisterService({ name, port })` → kills the corresponding child.
- `registerAddress` / `deregisterAddress` → **no‑op** with an info‑level log explaining that per‑container A‑records aren't published on Darwin (the existing reconciler code calls these, so they need to stay defined; documenting the no‑op there is enough).
- `connect`/`disconnect` → no‑op (no daemon connection state on Darwin).

The `mdns/darwin/avahi.js` filename remains for symmetry (it's the same shape on both platforms — the linux file uses Avahi, the darwin file uses dns‑sd; the function names pretend to be platform‑agnostic).

## 6. Architecture and rules

### CLI as the new boundary

Today's rule is: *only `lib/containerManager/linux/` may import `@grpc/grpc-js`*. On Darwin the equivalent is: **only `lib/containerManager/darwin/` may exec the `container` binary**. Adding a single rule to `docs/WISP-RULES.md` § Architecture and to `backend/src/lib/CLAUDE.md`:

> *Only files under `lib/containerManager/darwin/` may exec Apple's `container` CLI. Routes and other libs must not. New container operations on Darwin = new purpose‑named export from the containerManager facade.*

Justified under the existing CLI rule in `CLAUDE.md` ("No shell exec of binaries unless the alternative is very complex; validate with the user if the code should exec a CLI") — the alternative is reimplementing `Containerization.framework`'s XPC contract from Node, which is genuinely complex and unstable.

### Strict manager rule still applies

Same as Linux: zero Wisp‑glue imports. Darwin gets its own `containerError` factory (already present), its own validators (reuses `containerValidation.js` from `linux/` since those rules are pure JS — same trick the Darwin `containerPaths.js` does today).

### Facade contract unchanged

The list of exports from `containerManager/index.js` doesn't change. Every Linux export gets a Darwin counterpart with the same signature. Most Wisp‑glue code (`routes/containers.js`, `containerMdnsReconciler.js`, `containerApps/*`, jobs, sections) stays untouched.

## 7. Module‑by‑module implementation map

The Linux side has ~25 files. Darwin needs about half that. Directory layout (proposed):

```
backend/src/lib/containerManager/
  index.js                          # facade — unchanged
  linux/                            # unchanged
  darwin/
    index.js                        # re-exports + IS_DARWIN flag (already exists, gets fleshed out)
    containerCli.js                 # NEW — single entry point for `container` execFile + JSON parsing + error mapping
    containerManagerConnection.js   # NEW — `container system status` probe; no persistent socket
    containerManagerList.js         # NEW — `container ls --format json --all` + state poll loop + cache
    containerManagerLifecycle.js    # NEW — start/stop/kill/restart/getTaskState
    containerManagerCreate.js       # NEW — pullImage/createContainer/startExistingContainer/deleteContainer
    containerManagerImages.js       # NEW — listContainerImages/deleteContainerImage/getImageDigest/findContainersUsingImage
    containerManagerImageUpdates.js # mostly REUSED — Linux version is platform-agnostic; pull goes through facade
    containerManagerStats.js        # NEW — `container stats --no-stream --format json`
    containerManagerLogs.js         # PARTIAL REUSE — runs/sidecar/file-tail is identical; only the writer changes (tailer subprocess, see § 8)
    containerManagerExec.js         # NEW — `container exec -it` via child_process / node-pty
    containerManagerNetwork.js      # SHRUNK — vmnet IP discovery via `container inspect`; no CNI; no netns; no resolv.conf
    containerManagerNetworkEvents.js# REUSED with one tweak — the periodic probe now reads from `container ls`/`inspect` instead of /proc
    containerManagerSpec.js         # NOT NEEDED — no OCI spec building; `container run` flags do this
    containerManagerMounts.js       # REUSED — validation is pure JS; bind-source readiness checks are platform-agnostic
    containerManagerMountCrud.js    # REUSED entirely
    containerManagerMountsContent.js# REUSED entirely (file ops)
    containerManagerServices.js     # REUSED entirely
    containerManagerConfig.js       # REUSED entirely
    containerManagerConfigIo.js     # REUSED entirely
    containerManagerBackup.js       # REUSED — tar.gz logic doesn't touch the runtime
    containerManagerRename.js       # NEW — `container delete` + recreate (no Rename API in Apple's CLI either)
    containerImageRef.js            # REUSED entirely
    containerPaths.js               # REUSED entirely (paths come in via configure())
    atomicJson.js                   # REUSED entirely
    containerValidation.js          # REUSED entirely
```

"REUSED" means the Darwin index re-exports the same file from `linux/` (the file has no Linux‑specific imports). The dependency graph already does this for `containerPaths.js`, `containerManagerSpec.js`, etc. — it's the same trick applied more broadly.

Estimated new code: ~6 substantive new files (`containerCli.js`, lifecycle, list, create, images, stats, exec, network), totalling roughly **2,000–2,500 lines** including comments and error handling. Each is materially smaller than its Linux counterpart because the CLI does most of the work.

## 8. The shape of `containerCli.js`

This is the single chokepoint. Pseudocode‑ish:

```js
// containerCli.js
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { containerError } from '../linux/containerManagerConnection.js'; // pure factory, OK to share

const execFileP = promisify(execFile);
const BIN = process.env.WISP_CONTAINER_BIN || '/usr/local/bin/container';

export async function runCli(args, { input, timeoutMs = 30_000, parseJson = false } = {}) {
  try {
    const { stdout, stderr } = await execFileP(BIN, args, {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
      input,
    });
    if (parseJson) {
      try { return JSON.parse(stdout); }
      catch (err) {
        throw containerError('CONTAINERD_ERROR', 'container CLI returned non-JSON output', stdout.slice(0, 200));
      }
    }
    return { stdout, stderr };
  } catch (err) {
    throw mapCliError(err, args);
  }
}

function mapCliError(err, args) {
  const stderr = err.stderr?.toString() || '';
  // Exit codes / message patterns documented per-subcommand in the apple/container repo.
  // Examples:
  if (/no such container/i.test(stderr)) return containerError('CONTAINER_NOT_FOUND', stderr);
  if (/already exists/i.test(stderr))    return containerError('CONTAINER_EXISTS', stderr);
  if (/is not running/i.test(stderr))    return containerError('CONTAINER_NOT_RUNNING', stderr);
  if (/already running/i.test(stderr))   return containerError('CONTAINER_ALREADY_RUNNING', stderr);
  if (/cannot connect|apiserver/i.test(stderr)) return containerError('NO_CONTAINERD', 'container apiserver not running. Run "container system start".');
  return containerError('CONTAINERD_ERROR', stderr || err.message, stderr);
}

// Long-running streaming variant for `container logs -f`, `container stats` (without --no-stream), etc.
export function spawnCli(args) { /* returns ChildProcess; caller wires stdout/stderr/exit */ }
```

Every other Darwin manager file calls `runCli(...)` or `spawnCli(...)`. The error code catalogue in `docs/spec/CONTAINERS.md` § Error Codes carries over verbatim — the pattern matching above maps Apple's stderr strings to existing Wisp codes.

## 9. State polling instead of an event stream

Apple's `container` CLI has no documented event subscription. The Linux backend uses containerd's `events.subscribe` gRPC stream to drive list cache invalidation; Darwin has to poll.

**Cadence:**

- Background poll: `container ls --format json --all` every **3 s** while the backend is connected and at least one container exists. Uses `setInterval` + `unref()`. No gRPC keepalive overhead, so the cost is one CLI invocation per tick (cheap — `container ls` is well under 100 ms in practice).
- Event‑style fast path: every state‑changing call (`startContainer`, `stopContainer`, etc.) calls `refreshContainerListCache()` immediately on success.
- Reduce to **30 s** tick when there are zero containers running.

**This is not the "polling safety net" pattern flagged in `feedback_no_polling_safety_nets.md`.** That rule is about avoiding pollers that paper over event‑driven races. Here we don't have an event stream at all — polling is the primary signal. Document the distinction in the Darwin module's leading comment.

**Restart policies live here too.** When the poll observes `running → stopped` for a container, it consults `restartPolicy` on `container.json` and the last user action (tracked in‑memory: which name the user just stopped/killed, with a 5 s grace window):

| Policy | Last user action = stop/kill? | Re‑start? |
|---|---|---|
| `never` | — | no |
| `on-failure` | — | only if `exitCode != 0` |
| `unless-stopped` | yes | no |
| `unless-stopped` | no | yes |
| `always` | — | yes |

The `exitCode` comes from `container inspect <name> --format json`. This loop runs in `containerManagerLifecycle.js`, *not* in route handlers — same separation as Linux.

## 10. Logs: tailer subprocess + Wisp's existing run files

Linux uses containerd‑shim's `file://` LogURI to write directly to `runs/<runId>.log`. Apple's `container` CLI doesn't expose log redirection at create time; logs are only retrievable via `container logs [<name>]`. The replacement:

1. On `startExistingContainer`, allocate `runId` + open `runs/<runId>.log` for append, write the sidecar (`endedAt: null`), prune retention. Same as Linux.
2. After `container start <name>` returns, spawn `container logs --follow <name>` as a subprocess; pipe its stdout+stderr into the log file. Track the child process by `(name, runId)`.
3. Existing `streamContainerRunLogs` (file tail via `fs.watch` + interval) is platform‑independent and works unchanged for the SSE consumer.
4. On `stopContainer` / `killContainer` / observed exit, kill the tailer, finalize the sidecar (`endedAt`, `exitCode` from `container inspect`).
5. `cleanupTask` (called from start before re‑creating, and from stop) becomes "kill any tailer + finalize the open run".

Caveat: Apple's CLI may include some boot‑level log lines under `container logs --boot`. We default to **non‑boot logs only** to match containerd‑shim's behaviour. A `--boot` toggle could be added to the run‑download UI later.

## 11. Stats, exec, inspect

- **Stats.** `container stats <name> --no-stream --format json` returns `{ name, cpuPercent, memoryUsageMB, ... }` (exact field names taken from the live binary at implementation time — the current docs name CPU%, memory, IO, processes). Wisp's existing `getContainerStats` shape (`cpuPercent`, `memoryUsageMiB`, `memoryLimitMiB`, `netRxBytes`, `netTxBytes`, `uptime`, `pid`) is filled with what's available; net bytes go to `0` until/unless Apple exposes them. `pid` from `container inspect`.
- **Inspect.** `container inspect <name> --format json` is the swiss‑army getter — IP address, mounts, image, status, command. `containerManagerNetwork.darwin` reads it once after `container start` to capture the assigned vmnet IP and persist it into `container.json` (mirrors `mergeNetworkLeaseIntoConfig`).
- **Exec.** `container exec -it <name> /bin/sh`. Two viable Node integrations:
  - Add `node-pty` (native dep). Spawn `container exec` on a PTY, stream both directions to the WebSocket, handle resize via `pty.resize(cols, rows)` (which doesn't actually reach the inner CLI's PTY — Apple's CLI doesn't expose a resize hook today, so resize messages become host‑side terminal resizes only).
  - Skip `node-pty`; use `child_process.spawn` with `stdio: ['pipe','pipe','pipe']`. Loses TTY‑gated features (line editing, colours from some apps). Ship for v1; add `node-pty` if users complain.

Recommendation: **defer exec to phase 3**, ship lifecycle + stats + logs first.

## 12. Image library

- `listContainerImages()` → `container images list --format json`. Map to Wisp's existing shape (`name`, `digest`, `size`, `updated`). Persist the same `oci-image-meta.json` sidecar — completely platform‑agnostic.
- `deleteContainerImage(ref)` → `container images delete <ref>`. Pre‑check via `findContainersUsingImage` (uses `container.json` files — already platform‑agnostic).
- `getImageDigest(ref)` → `container image inspect <ref> --format json`, take the manifest digest.
- `pullImage(ref, onStep)` → `container pull <ref>`. SSE progress: `container pull` doesn't expose machine‑readable progress, so we report `step: 'pulling'` with periodic elapsed‑seconds updates (same UX as the Linux Transfer service which also has no real percentage).
- `checkAllImagesForUpdates`/`checkSingleImageForUpdates` → unchanged orchestration; just calls the facade. The "image was idempotent re‑pulled and digest didn't change" detection works the same way (compare digests before/after).

## 13. Wisp‑glue and frontend changes

The point of the strict facade is that nothing outside the manager needs to change. In practice a few small edits land in the glue:

- **`paths.js`** — return Darwin paths for `getVMBasePath` (no‑op since VMs are stub) and a new `getDefaultContainersPath()` that returns `~/Library/Application Support/Wisp/containers` on Darwin. Routes don't touch this — `backend/src/index.js` already passes a configured path into the manager via `configure()`.
- **`backend/src/index.js`** — drop the existing "macOS dev stub: skip container manager" early return; on Darwin, run `connect()` (which probes `container system status`), `startAutostartContainersAtBackendBoot()`, the same as Linux.
- **`routes/containers.js`** — *no functional change*. The route surface is identical; error mapping (`handleRouteError`) already covers the new Darwin error codes via the existing catalogue.
- **`routes/host.js`** — host stats already branch on platform for hardware/GPU/temps; no container code lives here.
- **`mdns/darwin/avahi.js`** — fleshed out per § 5.
- **Frontend.**
  - `ContainerNetworkSection` adds a Published Ports table on Darwin (or always — the field is harmless on Linux). MAC and Interface inputs hide on Darwin.
  - `ContainerDevicesSection` shows an empty/disabled state on Darwin: "Host device passthrough is Linux only".
  - `ContainerGeneralSection`'s `runAsRoot` toggle is hidden on Darwin (Wisp wouldn't action it anyway).
  - The Local DNS section's wording changes on Darwin: services advertise on `<host>.local`, no per‑container hostname.
  - A small platform flag is added to `GET /api/host/info` (we already return `kernel` and `nodeVersion`; add `platform: 'darwin' | 'linux'`) so the UI can branch.

The frontend platform branching is light — five or six conditionals, each guarded behind one `host.platform === 'darwin'` check.

## 14. Path layout, autostart, restart

- **Containers root.** `~/Library/Application Support/Wisp/containers/<name>/{container.json, files/, runs/}`. Same shape as Linux.
- **State file (last user action for restart policy).** In‑memory only. `containerStartTimes` already exists on `containerState`; add `lastUserStop: Map<name, timestampMs>` populated by `stopContainer`/`killContainer`, consulted by the poll loop.
- **Autostart.** Same flow as Linux: at backend boot, after `connect()` succeeds, walk `~/Library/Application Support/Wisp/containers/*` and `container start` everything with `autostart: true`. Failures logged per‑container, don't block.
- **`container system start` ownership.** We *do not* own the apiserver. If `connect()` finds it not running, we surface a 503 with a clear "run `container system start`" detail. The setup script (`scripts/install.sh` / future Darwin equivalent) runs it once at install time. Re‑running on every backend start would step on users who deliberately disabled it.

## 15. Risks and known gaps

| Gap | Severity | Mitigation |
|---|---|---|
| LAN reachability requires host port publishing | by design | Document; UI surfaces published ports prominently. |
| No event stream → polling | low | 3 s tick is cheap on Apple Silicon; immediate fast‑path on every state change keeps UX responsive. |
| `container` CLI is pre‑1.0 (Apple states breaking changes possible) | medium | Pin against a tested CLI version range in `containerCli.js`; refuse to start with an unsupported version and direct user to upgrade. |
| Stderr pattern matching for error codes is brittle | medium | Build a test suite that runs each subcommand against expected failure modes and snapshots the stderr — lives under `backend/test/darwinCli/`. Re‑run on CLI version bumps. |
| No tmpfs flag in `container run` | low | Reject `type: "tmpfs"` on Darwin with `CONTAINER_TMPFS_NOT_SUPPORTED_ON_DARWIN` until/if Apple adds the flag. |
| Exec without PTY loses interactive niceties | low | Add `node-pty` as an optional dep for a phase‑3 polish pass. |
| dns‑sd registration requires a long‑lived child per service | low | Phase 1 is N children; phase 2 can consolidate into one helper. |
| macOS host's published mDNS name is user‑configurable and changeable | low | Read it via `scutil --get LocalHostName` at registration time, surface in the UI on the Local DNS row. |
| Image storage location is owned by `container`, not by Wisp | low | We don't manage image files directly anyway — backups already exclude them on Linux. |
| `container` may behave differently on macOS 26.x patch versions | low | Pin a tested range; CI runs on the lowest supported macOS 26 minor. |
| File ownership semantics differ for Local mounts (no idmap) | medium | Document. Apps that hard‑require root‑owned mount data won't work on Darwin without modification — same kind of limitation Docker Desktop users live with. |

## 16. Phased delivery

Each phase is shippable. Code review and docs updates accompany each phase, not deferred.

**Phase 1 — read‑only and basic lifecycle (~1 week of focused work).**
- `containerCli.js`, error mapping, version probe.
- `connect()`/`disconnect()` against `container system status`.
- `listContainers()` via `container ls` + 3 s poll.
- `startContainer` / `stopContainer` / `killContainer` / `restartContainer`.
- `getContainerConfig` + `container inspect` for state/IP/uptime.
- `pullImage` + `createContainer` + `deleteContainer` (no mounts, no env, no published ports — just a stoppable "hello world" container).
- `startAutostartContainersAtBackendBoot`.
- Update `backend/src/index.js`, drop the macOS skip.
- Spec + UI doc updates.

**Phase 2 — full create/edit and stats (~1 week).**
- Env, command, CPU/memory limits, restart policy, autostart toggle, icon.
- Local + Storage mount support via `--volume`.
- Published ports (new `container.json` field, Network section UI changes).
- `getContainerStats` via `container stats --no-stream`.
- Restart‑policy enforcement in the poll loop.
- Rename via delete+recreate.

**Phase 3 — logs, exec, mDNS (~1 week).**
- Tailer subprocess + run files + log SSE.
- Exec via `container exec -it` (decide on `node-pty` vs plain pipes).
- `dns-sd` service registration; `mdns/darwin/avahi.js` rewritten.
- Frontend services UI labelling for Darwin (host port).

**Phase 4 — image library, updates, backups (~1 week).**
- `listContainerImages`, `deleteContainerImage`, `getImageDigest`, `findContainersUsingImage`.
- Image update checker integration.
- Backup/restore (mostly a port test — the tar logic is shared).
- `container image load` for local image import.

**Phase 5 — polish and testing (~1 week).**
- Error catalogue tests (every code reachable from a CLI failure).
- `WISP-RULES.md` + `CLAUDE.md` updates for the CLI‑caller rule.
- macOS install script.
- Documentation: a `Containers on macOS` section in `docs/spec/CONTAINERS.md` covering the networking model, published ports, the dropped features, and `container` CLI version requirements.

Total estimate: **~5 calendar weeks at one engineer focus level**, assuming no surprises in Apple's CLI. The biggest unknown is exec ergonomics and how Apple iterates the CLI between now and macOS 26.x point releases.

## 17. References

- Apple `container` CLI repo: `https://github.com/apple/container`
- Command reference: `https://github.com/apple/container/blob/main/docs/command-reference.md`
- How‑to: `https://github.com/apple/container/blob/main/docs/how-to.md`
- Technical overview: `https://github.com/apple/container/blob/main/docs/technical-overview.md`
- Wisp specs the Darwin work needs to keep in sync: `docs/spec/CONTAINERS.md`, `docs/spec/CUSTOM-APPS.md`, `docs/spec/STORAGE.md`, `docs/spec/API.md`, `docs/spec/UI.md`.
- Wisp rules updated by phase 5: `docs/WISP-RULES.md` § Architecture, `backend/src/lib/CLAUDE.md`.

## Appendix — invocation cheat sheet

A reference table for the implementer; not normative. Real flags get pinned at implementation time against the tested `container` version.

| Wisp operation | `container` invocation |
|---|---|
| Probe runtime | `container system status --format json` |
| List | `container ls --all --format json` |
| Inspect | `container inspect <name> --format json` |
| Pull | `container pull <ref>` |
| Create (stopped) | `container create --name <name> [--volume …] [--env …] [--publish …] [--cpus N] [--memory MG] <ref> [<cmd> …]` |
| Start (existing) | `container start <name>` |
| Stop | `container stop <name>` |
| Kill | `container kill <name>` |
| Restart | `container restart <name>` *(or stop+start)* |
| Delete | `container delete --force <name>` |
| Logs (tail to file) | `container logs --follow <name>` |
| Stats snapshot | `container stats --no-stream <name> --format json` |
| Exec shell | `container exec -it <name> /bin/sh` |
| Images list | `container images list --format json` |
| Image delete | `container images delete <ref>` |
| Image inspect | `container image inspect <ref> --format json` |
| Image load (tar) | `container image load -i <path>` |
| mDNS register service | `dns-sd -R <instance> <type>. local <hostPort> [k=v …]` (long‑lived) |
| Host mDNS name | `scutil --get LocalHostName` |
