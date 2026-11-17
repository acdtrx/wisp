# Cohesion and era-drift audit — 2026-11-17

Checks the repo at `78932bb` (v2.8.0-beta.1) for cohesion, era drift against the current
rule docs, and fitness for further change, and answers whether a full rewrite is
warranted. It is not a bug hunt or a security audit: those are 2026-10-16 and 2026-11-12.

Method: seven read-only sweeps, one per area (VM/host/storage/networking/mdns; containers;
routes and glue; frontend data layer; frontend components; docs and repo; deploy
pipeline), plus git-history measurements. Nothing was run on a Linux host. Every finding
was read in the code by its sweep unless marked **suspected**; the counts the conclusions
lean on were re-counted afterwards. `be/` = `backend/src/`, `fe/` = `frontend/src/`,
`cm/` = `backend/src/lib/containerManager/linux/`, `vm/` = `backend/src/lib/vmManager/linux/`.

## Verdict

- **Structure: sound and uniform.** Every backend subsystem is facade + `linux/` +
  `darwin/`; both lints pass (966 imports inside their fences, 704 paths resolve); route
  access is declared on all 135 routes and fails closed; every state-changing route
  answers with an ack; all 13 SSE handlers tear down the same way; the frontend has 5
  `fetch` sites and one multiplexed stream; every colour goes through `@theme`. No area
  graded "tangled".
- **Texture: two and a half eras.** About half of the surviving code lines date from
  April (backend 50%, frontend 51%, scripts 61%); 12% of the backend was written in the
  six days from 2026-11-12. The October and November code is visibly more careful than
  what it sits beside.
- **Why it drifts: each campaign added its mechanism beside the old one.** The October
  audit, the November conformance sweep and command acks each introduced a better pattern
  and converted only what they needed. New code takes the new pattern, old code keeps the
  old, so the number of variants rises with every campaign. This is the one mechanism
  behind most findings below.
- **Rules that were swept are uniform; rules that were not are where the drift is.**
  §4, §6, §7, Data, Layers and Phones were swept on 2026-11-12. §1, §2, §5, §10, §11,
  §15, §16 and FRONTEND-RULES Design, Files and UI patterns never were.
- **Changes are cheap in files touched and each one adds a copy.** A new container
  setting is 4–6 files, a new detail section 2, a fifth app 5. But the recurring shapes
  have no shared home, so each change copies 60–100 lines, and about half the steps of a
  new command are unenforced and silent when missed.
- **Rewrite: not warranted.** The debt is local and mechanical, every concern already has
  its target pattern in the repo, and the value of the codebase is about 80 platform
  quirks that only manual runs on a Linux host verify. See [Rewrite](#rewrite).

### Grades

| Area | Grade | Note |
|---|---|---|
| vmManager | workable | sound boundary; strained inside Config/Create/Disk/Iso/Usb |
| host | workable | the most dated: 89% April lines, failures swallowed |
| storage | workable | SMB and disk mount are near-twins |
| networking | healthy | |
| mdns | workable | `avahi.js` dense but the best-commented file |
| containerManager | workable | strained core: Create, Network, Lifecycle |
| containerApps | workable | close to healthy; a clean consumer |
| routes | strained | `vms.js` and `containers.js` written to different standards |
| flat glue | workable | close to healthy; no vestigial files |
| downloads, mcp | healthy | |
| library (backend) | workable | half a subsystem: writes moved, reads still in the route |
| jobs | strained | six stores, three wrapper shapes, seven progress endpoints |
| `fe/api/` | healthy | |
| `fe/store/` | workable | vm and container stores mirror by copy and have drifted |
| component data flow | strained | one mechanism, re-implemented per view |
| shared primitives | workable | healthy where they exist; no Button, Badge, Tabs, Field |
| styling tokens, dark mode | healthy | |
| `sections/`, `host/`, `apps/` | workable | Disks, NICs and three of four apps on the April idiom |
| `library/` (frontend) | strained | |
| install and setup scripts | workable | |
| privileged helpers | workable | each careful, four dialects |
| update and release flow | healthy | one gap: no CI gate |
| migrations | healthy | |
| rule docs | workable | 12 contradictions, 7 rules stated as met that are not |
| specs | strained | accurate contracts mixed with implementation mirrors |
| backlog | workable | live and accurate; a defect register that grows |

## Measurements

- Size: backend 39.4k lines (protos excluded), frontend 26.4k, shell and helpers 5.4k,
  docs 13.4k. Backend grew from 16.5k on 2026-04-10; docs peaked at 15.1k in October.
- Commits: 738. 141 are dated 2026-10-16 and 283 fall on 2026-11-12 to 11-17.
- Surviving lines by month written — backend: Apr 50%, May 8%, Jul 10%, Aug 3%, Oct 17%,
  Nov 12%. Frontend: Apr 51%, May 5%, Jul 14%, Aug 14%, Oct 5%, Nov 10%.
- 75 of 357 code files have not been touched since before October.
- November churn: backend +6,526 / −3,350, frontend +3,395 / −1,683, docs +5,599 /
  −7,168: about 0.8 doc lines per code line. 77 commits touch only docs.
- Files per `feat` commit, median: Apr 13, Jul 7, Aug 5, Oct 8, Nov 6.
- Dependencies: every package on its latest major; patch and minor updates only.
- Backlog: about 39 entries on 2026-10-23, 58 now; about 40 are known defects. 12 sampled
  against code: 12 still open and accurate.
- Frontend build: passes, no warnings; main chunk 357 kB (90 kB gzip).

## Cross-cutting findings

The same shape written many times, with no shared home. Each is small on its own.

- **X-1 — Hand-rolled change emitter, 33 copies.** `new Set()` + subscribe + try/catch
  fan-out: 10 in containerManager, 9 in the glue, 14 across vmManager, storage, host,
  networking and mdns. Three guard styles: logged, `console.error`, dropped silently
  (`be/lib/host/linux/usbMonitor.js:182`, `be/lib/storage/linux/diskMonitor.js:227`),
  and unguarded (`be/lib/homepage.js:38`, `be/lib/sections.js:26`). *Fix:* one emitter
  helper per fence (the strict managers each own theirs). S.
- **X-2 — Privileged-helper exec, 6 ways; locating the helper, 4 conventions.**
  `be/lib/storage/linux/helperExec.js:16` is the current one. Others:
  `networking/linux/managedBridges.js:115`, `host/linux/hostPower.js:47` and `:64`,
  `host/linux/smart.js:214`, `host/linux/hostHardware.js:416`, `host/linux/osUpdates.js:87`,
  `vm/vmManagerNvram.js:19` (bare name on `PATH`, the only one), and the
  `isRoot() ? … : sudo -n` branch five times in `cm/containerManagerNetwork.js`
  (`:201`, `:265`, `:348`, `:420`, `:527`). M.
- **X-3 — Logging, three to five conventions per area.** `state.logger?.x?.()`, a `log()`
  helper that falls back to `console`, a `log` parameter, bare `console.error` in facades;
  20 `console.*` calls remain in `be/`. `host` has 2 log calls in 3.4k lines. M.
- **X-4 — Facade export lists are hand-synced in three files** (facade, `linux/index.js`,
  `darwin/index.js`) with no parity check: a missed stub is `undefined` at call time.
  Since October 17 commits touched `containerManager/darwin/index.js`. *Fix:* a parity
  check in `check-imports`. S.
- **X-5 — Import cycles, 5, against "the import graph stays acyclic, enforced by a lint"**
  (`ARCHITECTURE.md:234`). No lint checks it (in backlog). Cycles: `vm/vmManagerList.js:17`
  ↔ `vm/vmManagerPendingRestart.js:25`; `mdns/linux/avahi.js:30` ↔ `forwarder.js:35`;
  three in containerManager hidden behind dynamic `import()`
  (`cm/containerManagerLifecycle.js:137`, `:150`, `:209`,
  `cm/containerManagerRestartPolicy.js:206`, `:250`). M.
- **X-6 — Nothing catches an undefined name or a stale hook dependency.** No ESLint, no
  tests; 5 `eslint-disable` comments remain for a linter that is not installed. The
  backlog records a crash on every container page that shipped during command acks.
- **X-7 — Unvalidated passthrough makes new fields appear to work.**
  `cm/containerManagerConfig.js:374` stores any unknown key; 8 of 9 body-reading container
  commands have no body schema (X-ref R-1).
- **X-8 — Seven template rules are written as met and are not**, tracked only in the
  backlog: the acyclic lint, one error handler, `error` as the stable code, schema
  validation at every boundary, commands as POST, errors stay visible, one job progress
  route.

## Backend — vmManager, host, storage, networking, mdns

- **V-1 — Read inactive XML → parse → mutate → build → define is written 13 times** in 7
  files, with no shared helper and no per-VM lock (the lock gap is in backlog). M.
- **V-2 — Device XML shapes are written twice**, once in create
  (`vm/vmManagerCreate.js:156-234`) and once in PATCH (`vm/vmManagerConfig.js:186-282`):
  8 shapes. CD-ROM literal 4 times; USB hostdev twice in one file. Every new device adds
  another pair. M.
- **V-3 — "Is it running" has 4 definitions over 13 numeric-literal sites**, though
  `libvirtConstants.js` exists. S.
- **V-4 — Firmware is expressed three ways** — **effect suspected.** Create writes a
  loader path and per-VM nvram (`vm/vmManagerCreate.js:145-150`); PATCH sets
  `firmware='efi'` for both `uefi` and `uefi-secure` (`vm/vmManagerConfig.js:204-212`);
  read decides by `loader secure='yes'` (`vm/vmManagerXml.js:172-183`), which create never
  writes. Likely: `uefi-secure` never reads back and a firmware PATCH orphans `VARS.fd`.
  Noted in `2026-10-16/RECHECK.md:59`, not in backlog. M.
- **V-5 — `updateVMConfig` is about 310 lines** with the rename flow nested three deep
  (`vm/vmManagerConfig.js:38-151`); `connectionState` is a mutable object imported by 17
  of 22 files.
- **V-6 — `host` swallows nearly every failure**: 41 of 46 `catch` blocks return
  `null`/`[]` with no log, so a failed SMART or dmidecode read is invisible (§4, §5).
  Sync `fs` on the main thread across `/proc` and `/sys` every 5 s, and `statfsSync` on
  every mount including CIFS (`be/lib/host/linux/hostHardware.js:234`): a dead hard-mounted
  share would freeze the backend — **suspected**; the backlog covers only the thread-pool
  case. M.
- **V-7 — `detectOSCategory` calls a VM Windows when its name contains "win"**
  (`vm/vmManagerXml.js:308-313`), against §4 "fail visibly rather than guess". S.
- **V-8 — Strict-manager leaks:** Wisp's cloud-init defaults inside vmManager
  (`vm/vmManagerCreate.js:26-51`); `mdnsHostname` in `getVMStats`; host facts split
  between `vm/vmManagerHost.js` and `host/`. S–M.
- **V-9 — §16: repair of a past bug sits in the normal path** ("legacy state from a
  pre-fix rename", `vm/vmManagerConfig.js:53-74`, `vm/vmManagerRename.js:31-90`), and
  `VM-MANAGEMENT.md:121` documents it as design. Older backup shapes are still read
  (`vm/vmManagerBackup.js:799-805`, `:191-208`, `:855`). Needs a ruling: backups sit
  outside migrations.
- **V-10 — mdns never reopens its bus** (`be/lib/mdns/linux/avahi.js:122-125`) while
  vmManager reconnects with backoff — **suspected**: a dropped system bus leaves mDNS dead
  until restart. M.
- **V-11 — Smaller:** three byte-identical error factories; `smbMount.js` and
  `diskMount.js` near-twins; 10 surviving `{ ok: true }` returns; generic facade exports
  (`start`, `stop`, `getDevices`, `onChange`, `refresh`) every caller renames with `as`;
  three cues for mount state; about 14 history-narrating comments. All S.

## Backend — containerManager, containerApps

- **C-1 — `container.json` is read three ways:** `readContainerConfig`, eight sites with
  their own `readFile` + `JSON.parse`, and one exact clone
  (`cm/containerManagerMountsContent.js:35-44`). S.
- **C-2 — "Is the name free" is checked in four places with two behaviours.** Three of
  them (`cm/containerManagerCreate.js:398-404`, `cm/containerManagerBackup.js:641-654`,
  `cm/containerManagerRename.js:25-47`) swallow everything but `CONTAINER_EXISTS`, so an
  unreachable containerd reads as "free". `getImageDigest` likewise reads an outage as
  "not local" and triggers a pull (`cm/containerManagerImages.js:117-124`). S.
- **C-3 — `containerManagerCreate.js` holds five domains** (pull, manifest resolution,
  snapshot, create, start/delete) in 925 lines and 45 commits, and sits in a cycle with
  Lifecycle. Splitting it removes two of the three cycles. M.
- **C-4 — §15: stacked fallbacks on the start and network path**
  (`cm/containerManagerNetwork.js:152-176`, `:193-233`, `:405-455`, `:427-433`): helper →
  direct plugin exec → `ip netns`; conflist → built-in default; IP from four sources.
  Also enum handling for bigint, number and digit strings though the loader is set to
  strings. Pruning needs a Linux host. M.
- **C-5 — "Strict manager" holds by lint, not in spirit.** SRV/TXT publishing lives in the
  manager (`deregisterServicesForContainer` called from 8 sites) while A-records moved
  out; the stub IP and resolv path are hard-coded (`cm/containerManagerNetwork.js:487-488`);
  the operation lock is injected but mutators do not take it, so 12 route sites plus MCP
  and the scheduler must; `getContainerConfig` returns secrets and masking lives in
  containerApps for every container. `atomicJson.js` and `containerValidation.js` are
  vendored copies kept for an "eventual library extraction". M–L, needs a decision.
- **C-6 — Dead:** the leases client and proto, an unused `grpc` import, `IS_DARWIN` on the
  facade, stats fields that are always 0 (`cm/containerManagerStats.js:26-28`). S.
- **C-7 — Smaller:** wait-until-stopped three times; is-running four ways; constants and
  the `containers.create` record copied between Create, Backup and Rename; the manifest
  walk (about 80 lines) twice; two progress-callback shapes; 7 of 34 files off the naming
  scheme; `containerError` defined twice; darwin imports from `../linux/`. All S.
- **C-8 — containerApps:** four modules alias `createAppError as containerError`;
  `jellyfin.js:18-39` copies two validators; the backend and frontend app registries
  duplicate label, description and default image; `applyAppConfig`
  (`be/lib/containerApps/index.js:353-501`) is the most fragile function in the layer.

## Backend — routes, glue, jobs

- **R-1 — Request schemas: `vms.js` has a body schema on all 8 body-reading commands,
  `containers.js` on 1 of 9**, and a params schema on 0 of 26. Validation there is
  `typeof request.body === 'object'`. The backlog lists only the PATCH. M.
- **R-2 — Response schemas on 78 of 132 routes**, though TECH-STACK calls them
  authoritative: 4 of 21 in `vms.js`, 5 of 32 in `containers.js`. M–L.
- **R-3 — Errors are answered four ways:** `handleRouteError` (84 sites), `sendError`
  (29), raw `reply.code().send` (dozens), and fall-through to the handler. Only the first
  and last redact paths. `library.js` uses the central mapping at 0 of 20 error sites.
  `error` carries the message, not the stable code §5 asks for (in backlog). 22 codes in
  the switch are missing from `ERROR-HANDLING.md`. M; the shape change is L.
- **R-4 — Jobs are created two ways:** a hand-rolled block at 11 sites, `startOperationJob`
  at 15. Six stores, seven progress endpoints (in backlog). Old and new sit in the same
  file (`be/routes/vms.js:226` against `:452`). M.
- **R-5 — Backup orchestration is written three times** (`be/routes/vms.js:321-377`,
  `be/routes/containers.js:539-589`, `be/lib/containerBackupScheduler.js:157-200`), with a
  fourth variant at `be/routes/backups.js:102-136`. S–M.
- **R-6 — Orchestration that lives in a route cannot be reused.** The container PATCH's
  mDNS nudge, removed-mount delete and section move (`be/routes/containers.js:406-467`)
  are unreachable from MCP. The VM side already forgot two follow-ups containers do
  (backup status on delete, section on rename; both in backlog).
- **R-7 — The image-update check never appears in the job tray after a reload:**
  `be/lib/jobs/listBackgroundJobs.js:23-29` omits `imageUpdateJobStore`, while
  `API.md:56` lists its kind. Confirmed.
- **R-8 — §7 outbound HTTP:** global `fetch` at `be/routes/cloudinit.js:153` and
  `be/lib/oidc.js:42` is outside `lib/downloads`; the lint checks only the `undici`
  import. S.
- **R-9 — A new job command has about 12 touch points, 6 unenforced and silent when
  missed:** body schema, response schema, operation lock, error code in the switch, change
  cue, and the Wisp-side follow-ups on rename or delete.
- **R-10 — Smaller:** 26 of 32 container routes use a different declaration form; the 202
  schema exists as three constants and 9 inline copies; `decodeURIComponent` on an
  already-decoded `mountName` at 8 sites (**suspected** to misresolve a name containing
  `%`); dead `redactToken` for `?token=` URLs (`be/index.js:87-91`). All S.

## Frontend — data and state

- **D-1 — "GET on mount, numbered reads, follow a cue, loading and error flags" is
  written by hand in 11 components and 3 stores**, in three guard variants. *Fix:* one
  `useRecord(kind, id, fetch)` hook. M.
- **D-2 — The section form (`form` / `original` / `init`) is copy-pasted with hand-kept
  dependency arrays** (`fe/components/sections/GeneralSection.jsx:24-49`,
  `AdvancedSection.jsx:84-86` and `:100-102`). Forgetting a field means it never
  refreshes after a save from another tab, and nothing lints it. The four app sections
  already reset by signature. M.
- **D-3 — Following a job, 4 ways:** `awaitJob` (about 20 sites, current),
  `registerJob({ onTerminal })` (4), reading the tray row by id (4), raw
  `subscribeJobProgress` (1). The create panels still refetch by hand
  (`fe/components/vm/CreateVMPanel.jsx:222-240`). M.
- **D-4 — "Busy with a backup" is decided by comparing the job's display title** to
  `` `Backup ${name}` `` in 6 places. A wording change unlocks every control; a
  same-named VM and container may mark each other busy (**suspected**). *Fix:* a
  `subject` field on the job row. S–M.
- **D-5 — vmStore and containerStore mirror by copy** (about 250 parallel lines) and have
  drifted; 8 backlog entries are races in them. Three lifecycle naming conventions across
  the stores; error frames recorded in five and dropped in two.
- **D-6 — Error text: 46 sites show `err.detail || err.message`, 45 show `err.message`.**
  Inline section errors have no dismiss (about 34 files), against FRONTEND-RULES Errors.
- **D-7 — Topic and kind names are bare strings on both sides:** a typo never fails, and
  `sendAndAwait*` resolves silently after 30 s (`fe/api/events.js:140-162`). An unknown
  job kind throws in `hydrate()` and drops the rest of the tray.
- **D-8 — Tripped over:** a failed "Eject" rejects unhandled and shows nothing
  (`fe/apps/AppConfigWrapper.jsx:19-22`).
- **D-9 — Smaller:** `createSSE` and `createJobSSE` are a 140-line twin; no wrapper takes
  a `signal`; a 401 is recognised downstream by the string `'Session expired'`; bridge
  pickers never follow `network-bridges`; `hostStore` is a fossil; 5 unused exports.

## Frontend — components and design

- **U-1 — No Button primitive: 257 `<button>`, 46 on a shared constant, 91 distinct
  literal class strings.** `ActionButton` exists twice, privately. The 2026-11-14 tap
  target sweep fixed its listed sites and left at least 17, because there is no one place
  to fix. A new button variant touches 35–75 files. M–L, mechanical.
- **U-2 — The same holds for badges (about 25 hand-rolled), tabs (one string, six
  copies), dismissable error banners (16 copies), progress bars (10), sub-headings (six
  implementations) and form labels (two idioms).** Each S.
- **U-3 — `isCreating` now hides two editors behind one flag** (91 references).
  `DisksSection.jsx` is two components in one file: about 430 of 989 lines are
  create-only. §2's own "split rather than add a flag" applies. M.
- **U-4 — The four app UIs share a data skeleton and solve the editable sub-list four
  ways.** M.
- **U-5 — `ImageLibrary.jsx`, the named reference implementation, is on the April idiom**
  (`rounded-sm` borderless buttons, a hand-rolled modal footer) and has a dead `page`
  mode. M.
- **U-6 — Naming (§1):** VM sections unprefixed, container ones prefixed; `VM`/`Vm` and
  `USB`/`Usb` casing mixed; `settings/` holds App Config sections; `sidebar/` holds one
  file. M (renames).
- **U-7 — Smaller:** `formatBytes` three times with different unit labels;
  `DisksSection.jsx:638` prints GiB as "GB"; 15 raw inputs bypass `input-field`; about 15
  icon buttons with `title` only; `BackupsPanel.jsx:656` and `:696` double-pad their
  confirm bodies.
- **Cheap today:** any colour or theme change is `index.css` only (dark mode needed 5
  `dark:` uses in all components); modal behaviour is `Modal.jsx` only.

## Deploy, update, release

- **P-1 — A fresh install on a host without a bridge ends without VM or container
  networking.** `scripts/linux/install.sh:78` always passes `--skip-bridge`; `cni.sh`
  then waits 30 s and exits before writing the conflist and `cni-dhcp.service`;
  `bridge.sh` is offered only when interactive, and `cni.sh` is never re-run after it;
  `libvirt.sh:43-48` has already disabled the default NAT network. The README mentions
  neither script. Confirmed by reading, not executed. Not in backlog. M.
- **P-2 — No CI gate before a release is published.** `release.yml` runs no `bash -n`,
  `check-imports` or `check-fences`. A broken `wisp-updater` ships dark and breaks the
  following update, where there is no fallback. S, and the highest-value change here.
- **P-3 — Two documented manual upgrade paths skip migrations** (`DEPLOYMENT.md:277-279`),
  and `wispctl` has no `migrate` command. Under §16 a backend started that way can meet
  unmigrated state. S.
- **P-4 — Seven of eleven setup steps never reach updated hosts** (packages, groups,
  dirs, libvirt, containerd, cni, rapl). In backlog ("Setup strategy"). A new system
  dependency or a Node major bump reaches new installs only. L.
- **P-5 — noVNC is cloned unpinned at upstream HEAD at build time**, in CI and on hosts
  (`scripts/vendor-novnc.sh:20`), while CNI and NodeSource are pinned. S.
- **P-6 — Nine helpers in about four dialects** (exit codes, stdout or stderr, flags or
  positional, EUID check), and CODING-RULES has no shell rules: §12 covers JavaScript
  only, while 3.3k lines of the most privileged code are bash. M.
- **P-7 — Smaller:** `sanity.sh` can never fail; `wisp-cni` and `wisp-netns` are tracked
  non-executable; the version is read from three `package.json` files by three consumers;
  the tree file list is kept in three places; `idle_run` exists twice and has diverged;
  legacy cleanups for `wisp-smb` and `wisp-update` never expire; `wispctl local` and
  `wispctl helpers` predate the current flow. All S.
- **P-8 — `DEPLOYMENT.md`: 12 of 31 checked claims miss**, among them the two-step flow
  diagram, the step order, "prereleases are not surfaced" (stale since the beta channel),
  and `git push origin`.

## Docs and repo

- **O-1 — Contracts are accurate.** All 135 routes documented, none extra; MCP 16 tools
  of 16; migrations, env keys, the exec allowlist and the dependency inventory all match.
  The `API-*.md` files, CONFIGURATION, AUTH, MCP and UPDATES can serve as a behavioural
  contract.
- **O-2 — Specs mix contract with implementation mirror**, against "document decisions
  and contracts, not implementations". `CONTAINERS.md:301-341` is a 35-row module table
  (already missing two files); `VM-MANAGEMENT.md:318-441` a file-by-file inventory stale
  in at least 9 places, including a section for `vmManagerCloudInit.js`, which does not
  exist; `UI.md` (78 KB) a screen-by-screen walk; `DEPLOYMENT.md` a script walkthrough.
  The misses found in spec-versus-code checks sit in these sections. The backlog's planned
  split of CONTAINERS and UI moves content unchanged, which would not remove them.
- **O-3 — Facts with two to four homes:** the exec allowlist (3), the deploy flow (4),
  the mount object shape (3), directory layouts (3), modal and table patterns (2), system
  packages (TECH-STACK omits four).
- **O-4 — 12 doc-to-doc contradictions.** `README.md:99` "24-hour JWT sessions" against
  a sliding 7-day session; `wisp.md:17` dark mode "a backlog matter" against the shipped
  dark theme; §5's "Applied" line carrying the shape its principle rejects; §2 `isCreating`
  against FRONTEND-RULES Variants; `UI.md:57` "No service worker"; AGENTS's
  `IMPLEMENTATION.md` against nine `PLAN-*.md` files.
- **O-5 — Era drift in the docs is concentrated:** `noVNC.md`, `USB.md`, `DEPLOYMENT.md`,
  `SETTINGS.md`, `HOST-MONITORING.md` and `UI.md` § Component Patterns are April prose;
  the rule docs, `API-*.md`, `UPDATES.md` and the backlog are current.
- **O-6 — Leftovers:** `web/` (a landing page from the first commit that advertises
  snapshots, referenced by nothing); `docs/reviews/2026-04-28/` (2,684 lines of plans with
  no completion status and dead paths; 7 sampled items done); README (session lifetime,
  app list, no mention of OIDC, dark theme, Home or container backups); screenshots from
  before the palette change; `BACKLOG.md` has no headings and one duplicate entry
  (`:42` and `:362`); no `engines` field for the Node 24 constraint.
- **O-7 — Process weight.** Mandatory pre-read is 113 KB before any spec; the largest
  spec is 129 KB. Command acks took 106 commits and about 600 changed doc lines for 4,364
  changed code lines, apart from the API split. The docs pay for themselves where they
  hold contracts and are a tax where they mirror code.

## Rewrite

Not warranted. What the sweeps found, area by area, is debt a rewrite would not be needed
to remove and knowledge a rewrite would put at risk.

- **The value is platform knowledge that nothing tests.** About 80 quirks are encoded
  with their reasons: 17 in containerManager (proto field numbers, `Any` encoding, the
  keepalive containerd tolerates, snapshot chain IDs, exec FIFOs, CNI and DHCP behaviour,
  idmapped mounts), 14 in vmManager, storage and mdns (dbus-next on a dead bus,
  inactive-XML defines, avahi 0.8's probe leak, qemu-img stall probes), 16 in the scripts
  (self-replacing updater, the DNS stub interface, apt non-interactivity, libvirt socket
  modes), 15 in the HTTP layer and 14 in the client's transport. Only manual runs on a
  Linux host verify any of them. A rewrite has no way to learn it lost one.
- **The debt is mechanical.** Every concern already has its target pattern in the repo;
  the work is converting the old copies to it. Nearly every finding above is sized S or M.
- **A rewrite under the same process reproduces the mechanism.** The drift comes from
  converting only what a campaign needs, with no tests or lint to hold the line.
- **What only a rewrite could change** is the set of structural deviations: no
  TypeScript, no tests, no database, no event bus, no ESLint. Tests and lint can be added
  in place. The other three are recorded decisions the sweeps found no reason to reopen.
- **File-scale rewrites are warranted**: `routes/containers.js` and `routes/library.js`
  to the standard of the current routes; the job stores into one; `DisksSection.jsx` and
  `VmNetworkInterfacesSection.jsx` split into create and detail; `ImageLibrary.jsx`;
  `containerManagerCreate.js` split by domain.

## Recommended order

1. **A safety net, before any conversion.** A CI gate in `release.yml` (P-2); a lint for
   undefined names and hook dependencies (X-6); facade parity (X-4) and a cycle check
   (X-5) in the existing lint scripts; a small unit harness for the closure-pure timing
   code (`fe/api/events.js`, `fe/api/sse.js`, the two workload stores).
2. **Fix what was tripped over:** P-1, P-3, P-5, R-7, C-2, D-8; confirm or dismiss V-4,
   V-6, V-10, D-4 and R-10's `mountName` on the Linux host.
3. **The shared homes**, one per recurring shape: emitter (X-1), helper exec (X-2),
   logger (X-3), container config read (C-1), the define helper (V-1), `useRecord` (D-1),
   the section-form hook (D-2), `errorText` (D-6), Button, IconButton, Badge, Tabs, Field
   and ErrorBanner (U-1, U-2). Then sweep the callers.
4. **Converge the routes:** schemas on `containers.js` (R-1), one error path (R-3), one
   job mechanism (R-4), backup orchestration into the glue (R-5).
5. **The file-scale rewrites** listed under Rewrite.
6. **Docs, each the user's call:** cut the mirror sections (O-2), give each fact one home
   (O-3), settle the contradictions (O-4), close or remove the old plans and `web/` (O-6),
   decide on shell rules for CODING-RULES (P-6), rule on §16 for backups (V-9) and on what
   "strict manager" covers (C-5).
7. **Sweep the rule sections never swept** (§1, §2, §5, §10, §11, §15, §16; FRONTEND-RULES
   Design, Files, UI patterns), as 2026-11-12 did for the others.
