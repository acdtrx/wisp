# Backlog

Pending small items, one entry each. Items that outgrow their entry graduate
to a plan in `docs/plans/` (see `CLAUDE.md` § Plans).

- **Sidebar: manual within-section workload ordering** — a third sort mode
  alongside alphabetical and online-first; the order lives on the section
  assignments so it is the single ordering shared by every consumer. Revisit
  when: the existing sorts demonstrably fight a real workflow — repeatedly
  hunting for a workload the sort keeps burying.
- **Live VM memory growth (balloon headroom / virtio-mem)** — wisp pins
  `<memory>` equal to `<currentMemory>`, so a running VM's RAM ceiling is its
  boot-time size and every increase costs a stop/start. Writing `<maxMemory>`
  above `<currentMemory>` and driving the virtio balloon (or virtio-mem) live
  would allow growth without restart. Semantics to design: how much headroom
  to define, guest cooperation, and what the Overview shows. Trigger observed
  2026-08-26: the play VM (4 GiB) OOM-killed a working agent session and the
  RAM bump required restarting everything inside. Revisit when: it happens
  again, or a memory bump needs to land on a VM that can't be restarted.
- **Optional SSO on Caddy hosts (Pocket ID)** — per-host auth toggle on the
  Caddy app's reverse-proxy records. Explored 2026-08-28/29, settled shape: a
  forward-auth gateway as a new wisp app container + `hosts[].sso` flag whose
  Caddyfile emission adds `forward_auth <gateway> { uri ... }` in the host's
  handle block (no Caddy image change — forward_auth is core Caddy;
  caddy-security in the custom image was considered and rejected: front-door
  blast radius, config surface, Pocket ID friction reports). Gateway choice is
  the open decision: **Tinyauth** (per-app group rules referencing Pocket ID
  groups via the `groups` claim — authz membership stays in Pocket ID; but NO
  bearer-token support, so machine clients need per-app API keys + per-host
  "SSO bypass paths" emitted as Caddy matchers) vs **oauth2-proxy**
  (`--skip-jwt-bearer-tokens` validates Pocket ID JWT access tokens for
  non-interactive clients; clunkier config, weaker per-app groups). Pocket ID
  admin-API client provisioning is optional sugar — one client total in the
  forward-auth model. Wisp wrinkles noted: TINYAUTH_AUTH_TRUSTEDPROXIES wants
  Caddy's (DHCP) IP; `hosts` is agent-writable via MCP so the sso flag needs
  the human-only treatment. Revisit when: the user schedules the auth session.
- **VM backups include vTPM (swtpm) state** — backups copy disks, NVRAM and
  cloud-init but not `/var/lib/libvirt/swtpm/<uuid>/` (root-owned, keyed by
  UUID), so restore-as-new boots with an empty TPM; the gap is documented in
  `docs/spec/BACKUPS.md` § Not backed up (audit 2026-10-16, V18). Shape: a
  privileged helper (registered in `install-helpers.sh` + sudoers per
  DEPLOYMENT.md) that copies the state dir into the backup and back under the
  restored VM's UUID. Revisit when: a restored Windows VM needed BitLocker
  recovery.
- **Per-container seccomp opt-out** — every container runs under Docker's
  default seccomp profile (CONTAINERS.md § OCI Runtime Spec). An opt-out would
  be a `container.json` field (e.g. `seccomp: "unconfined"`, no UI, editable
  via PATCH/MCP) read at the single place `buildOCISpec` sets
  `linux.seccomp` — omit the block when set. Revisit when: an image the user
  needs fails with EPERM/ENOSYS on a syscall the default profile blocks (and
  a capability grant or image setting can't fix it).
- **VM mDNS reconciler: per-VM operation chain** — `vmMdnsReconciler.js` has
  the race the container reconciler had (async handlers can register after
  the following stop's deregister); avahi `registerAddress` also leaks an
  entry group when two calls for one key overlap. The container side
  serializes per container. Revisit when: a stopped VM is seen still
  resolving as `<name>.local`, or avahi shows duplicate groups for a VM.
- **Stuck-probe recovery misses removals outside Wisp** — the avahi 0.8
  probe-counter leak (CONTAINERS.md § Stuck-probe recovery) is recovered only
  after Wisp's own interface removals. Observed 2026-10-21: unattended-upgrades
  (liblzma5) had needrestart restart avahi-daemon and systemd-networkd in the
  same second; `reregisterAll` committed every group, networkd re-applied
  `br0`'s addresses (avahi: "br0.IPv4 no longer relevant", then re-added)
  while they probed, and every Wisp name stopped resolving on the LAN for
  ~14 h — `git` to `cala.local` failed — until a cala restart's netns removal
  re-published them. Caddy and container lookups were unaffected (the
  forwarder answers from Wisp's own table). An avahi restart alone does not
  reproduce it. Candidate fixes: (1) reinstate the per-Commit deadline (a
  group still `REGISTERING` ~10 s after Commit is re-committed) and drop the
  per-removal triggers it makes redundant — reverses the 2026-10-16
  rejection, but a stuck group emits no signal to wait on; (2) re-publish on
  systemd-networkd link/address change signals — event-driven, covers only
  networkd flaps, races avahi's own netlink handling; (3) defer
  `reregisterAll` until avahi's Server reaches RUNNING — avoids this exact
  ordering only by luck. Confirm first with
  `systemctl restart avahi-daemon systemd-networkd`. Revisit when: Wisp
  `.local` names go dead on the LAN again, especially after an
  unattended-upgrades run.
- **Rename removes the old netns without CNI DEL** — `renameContainer`
  deletes the old-name netns directly, so the cni-dhcp daemon is never told
  to release that lease (same MAC, so the address itself is unaffected).
  Revisit when: cni-dhcp logs renew errors for a renamed container's old name.
- **Services stay published after an unexpected task exit** — SRV/TXT
  services are deregistered on stop/kill/delete only; a crash leaves them
  advertising until the next start or stop. Revisit when: a crashed
  container's service is seen being browsed on the LAN.
- **Adopt kept VM disks at create** — *Delete VM, keep disks* leaves
  `vms/<name>/`, and create/restore refuse that name (409
  `VM_DIR_EXISTS`, settled 2026-10-16); reusing a kept disk means moving it
  into the image library by hand and picking it as an existing disk. Shape: the
  create form offers the kept `disk*.qcow2` of a blocked name. Revisit when:
  reusing kept disks through the shell becomes a recurring chore.
- **Running-VM edits that need a restart don't all say so** — Graphics, NIC
  and video-driver changes on a running VM land in the inactive definition but
  return `requiresRestart: false` (only memory, CPU, machine, firmware, OS type
  and vTPM flag it); `graphicsType` / `videoDriver` accept any string; ISO
  attach/eject on a *paused* VM is config-only. Revisit when: a running-VM edit
  is reported as "didn't apply", or a bad graphics/video type breaks a define.
- **VM rename / disk edges** — rename's existing-target-dir guard answers 422
  `CONFIG_ERROR`, not 409 `VM_DIR_EXISTS` like create/restore. The UI also
  can't add an `sda` disk to a VM created without disks. Revisit when: a client
  needs to tell the rename conflict apart, or a disk-less VM needs a primary
  disk.
- **App config saves on a running container always flag Restart required** —
  `applyAppConfig`'s first write includes `mounts`, and any `mounts` write on a
  running container sets `pendingRestart` even when the list is unchanged, so a
  save that live-reloaded still shows the badge; the flag also survives an
  `APP_RELOAD_FAILED` rollback. Shape: `updateContainerConfig` flags a restart
  only when the normalized mounts/devices differ. Revisit when: the badge is
  seen after a Caddy / tiny-samba save that reloaded fine (likely on the next
  Caddy host edit — verify then).
- **App containers: devices and row-scoped mount routes bypass appConfig** —
  `PATCH {devices}` and the Devices section work on app containers, but
  Jellyfin's next `appConfig` save replaces them with its derived devices; the
  row mount routes (`POST`/`PATCH`/`DELETE …/mounts`, `/zip`, `/init`,
  `DELETE …/data`) aren't guarded for app containers while a `mounts` PATCH is
  `APP_CONFIG_ONLY`. Revisit when: a manual device pick on an app container is
  lost on a config save, or an app breaks after a raw mount edit.
- **Container mount edge cases** — `updateContainerMount` returns
  `requiresRestart: null` when the container has no task; switching a
  tiny-samba share from Local to a Storage source leaves `files/share-<name>`
  behind. Revisit when: orphan share directories turn up, or a client trips on
  the null.
- **Removable disk mount state uses the first mount point** — `mountedAt` is
  the first `/proc/self/mounts` entry for the device, so a drive a desktop also
  automounted elsewhere can read as not mounted by Wisp. Revisit when: a drive
  shows unmounted while Wisp has it mounted.
- **libvirt unreachable at boot is never retried** — a failed connect at
  startup logs a warning and gives up; only a dropped established connection
  reconnects with backoff (V17). Revisit when: wisp comes up before
  libvirt-dbus and VM pages stay empty until a restart.
- **Self-update install has no in-flight guard** — two concurrent
  `POST /api/updates/install` (two tabs) both download, stage and trigger the
  updater. Revisit when: a doubled install request causes a failed or repeated
  update.
- **Library upload name check races** — an upload checks `access()` and then
  writes, so two concurrent uploads of one name both pass and the later
  overwrites (no crash); downloads already reserve names with an exclusive
  create. Revisit when: two same-name uploads are seen colliding.
- **VM/container stores share one action slot** — `withAction` keeps one
  `actionLoading` / `error` per store, so an action still running on A
  disables B's buttons and can show A's error on B after a switch. Revisit
  when: a wrong-workload error or stuck-disabled button is reported.
- **Change-password attempts are not rate-limited** — the route needs a
  session, so only a stolen session can brute-force the current password.
  Revisit when: login hardening is scheduled (pairs with the 2026-07-05 audit's
  M1/M2).
- **Dev backend listens on every interface** — `app.listen` binds `0.0.0.0` in
  development too, exposing the dev stack (stub managers, dev CORS) to the LAN.
  Revisit when: developing on a network that isn't trusted.
- **Helper hardening leftovers** — `/mnt/wisp` is deploy-writable (0775), so
  `wisp-mount`'s realpath + symlink checks can't fully close a race by the
  deploy user; `wisp-cni` only checks that the netns argument is absolute (it
  could name the host's netns and disrupt host networking). Both need the
  deploy user, which is root-equivalent anyway (UPDATES.md § Privilege model).
  Revisit when: the deploy user is separated from root (e.g. signed updates
  staged by a root-owned path).
- **Hardware temperature reads may wake disks** — host stats read hwmon every
  5 s; with `drivetemp` loaded a SATA disk's sensor read can keep it from
  standby, which SMART reads now respect (`-n standby`). Revisit when: disks on
  a host with `drivetemp` never reach standby.
- **Arch: a custom pacman `DBPath` isn't followed** — `wisp-os-update`'s
  scratch sync database assumes `/var/lib/pacman`. Revisit when: an Arch host
  with a custom `DBPath` runs Wisp.
- **Domain XML parser: `serial` array rule also hits disk `<serial>`** — the
  `isArray` list matches by element name, so a disk's `<serial>` text parses as
  an array like the `<serial>` char device. Revisit when: disk serials are read
  from domain XML (UI/API) or show up as arrays.
- **Malformed-URL errors skip the `{ error, detail }` shape** — Fastify's
  `FST_ERR_BAD_URL` (bad percent-encoding) is answered before
  `setErrorHandler`, in Fastify's default shape. Revisit when: a client depends
  on the uniform shape for malformed URLs.
- **Live-data SSE retries a 404 forever** — `createSSE` treats a 404 like a
  dropped connection and backs off indefinitely (job streams stop on 404).
  Revisit when: a stream for a deleted workload is seen retrying.
- **Reload failure detail may echo secrets** — `APP_RELOAD_FAILED` carries the
  app's error lines verbatim to the UI and MCP; an app that prints a token in
  its error would surface it (unconfirmed). Revisit when: a reload error is
  seen carrying a secret value.
- **Backup completion carries an absolute server path** — the backup job's
  `done` result includes the backup's path on the host; undocumented and
  unused by the UI. Revisit when: the job-result contract is next touched, or a
  client starts reading it.
- **avahi `deny-interfaces` for `veth*` / `vnet*`** — avahi publishes the host
  name on every container veth and VM tap; the forwarder already ignores those
  link-local answers (CONTAINERS.md § Local DNS, settled 2026-10-16), and
  stopping them at the source means rewriting `avahi-daemon.conf` in place (no
  drop-ins). Revisit when: a non-container consumer is hurt by the per-veth
  records.
- **OS upgrade runs inside wisp.service** — `wisp-os-update upgrade` (apt/dpkg) is a child of the
  backend, so a Wisp self-update (its first step stops the service), a backend crash or the 600 s
  execFile timeout can kill dpkg mid-upgrade. Fix shape: run it in its own oneshot unit started via
  one fixed sudo rule (like `wisp-updater`), or at least refuse a self-update while an upgrade runs
  and drop the timeout. Revisit when: an upgrade is ever interrupted, or OS upgrades become
  unattended/scheduled. (re-review 2026-10-16, P2)
- **VNC console doesn't retry after a mid-session network drop** — noVNC reports a dropped
  connection as a clean close, so the console shows "disconnected" instead of reconnecting like
  the container console does. Revisit when: a VNC console stays blank after a mid-session network
  drop and needs a manual reopen. (Plan 6, B3)
- **Dev backend loads runtime.env after config** — `backend/src/index.js` has the import-order
  issue the migration runner had (P5): `WISP_CONFIG_PATH` from `runtime.env` is read after config
  resolution. Production sets it through the unit's environment, so only a dev setup relying on
  `runtime.env` is affected. Revisit when: a dev or test setup points `WISP_CONFIG_PATH` through
  `runtime.env` and gets the default config. (Plan 6, B4)
- **Cloud-init PUT for a VM that doesn't exist creates its directory** — the route doesn't check
  the VM first. Harmless leftover directory, but it blocks a later create under that name
  (`VM_DIR_EXISTS`). Revisit when: a stray VM directory from it shows up. (re-review 2026-10-16, V8)
- **Allowed-roots check follows symlinks** — `assertPathInsideAllowedRoots` uses `path.resolve`,
  not `realpath`, so a symlink placed inside the image library can point outside it. Only the
  admin can place files there. Revisit when: anything other than the admin can write into the
  image library or another allowed root. (Plan 6, B1)
- **A container that exits on its own never finalizes its run** — `finalizeRun` is only called
  from `cleanupTask` (stop / kill / start / delete), so the run keeps `endedAt: null` in `GET
  /runs` and a last line without a trailing newline is never shown. Fix shape: finalize on the
  task-exit event. Revisit when: a self-exited container's last output is missing or its run shows
  as still open. (Plan 6 verification on tini)
- **Small container API/UI inconsistencies** — `POST /api/containers/:name/mounts` returns
  `requiresRestart: null` on a stopped container (spec: boolean); the container page keeps
  "Restart required" up after a restart done outside the page (stale frontend flag);
  `backup-status.json` keeps entries for deleted containers. Revisit when: any of them confuses a
  real session. (Plan 6 verification on tini)
