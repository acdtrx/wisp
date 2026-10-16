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
