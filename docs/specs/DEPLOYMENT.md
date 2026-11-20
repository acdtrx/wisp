# Deployment

Wisp runs directly on a Linux server as a single systemd service — never in a container. One Node process serves the API and the prebuilt SPA. This document is the contract for installing Wisp, for setup (what the install and every update run), and for a manual upgrade: what the operator runs, what is asked, and what the host looks like afterwards. How an update from the UI works is [UPDATES.md](UPDATES.md).

## Supported hosts

(settled 2026-11-18)

- **Debian or Ubuntu** (or a derivative that names one of them in `ID_LIKE`) with **systemd 254 or newer** (Debian 13, Ubuntu 24.04 and later; read from `systemctl --version`, not from the release number: the unit's restart backoff needs it). Arch Linux is dropped as a host; it stays as a guest.
- **KVM is not required** (settled 2026-11-19).
  - A host that can run only containers is still a useful Wisp host. Rejected: refusing a host without `/dev/kvm`.
  - Setup sets up VMs and containers alike on every host, so turning KVM on later needs nothing reinstalled.
  - On a host without `/dev/kvm` the run succeeds, and setup's last lines say that the host cannot run VMs, why, and how to turn virtualization on (the firmware's setting, or nested virtualization when the host is itself a VM; then a reboot). The installer ends with them too; in the update's log they close setup's part, before the updater's `step:start-service` and `step:done`.
  - Containers need nothing of the host that setup does not install itself on a supported host, so there is no container counterpart, and no host is refused for lacking both.
- **The network run by netplan**, rendered by systemd-networkd, and an **IPv4 default route**: its interface is the uplink (settled 2026-11-20).
  - A host whose uplink it does not run is refused before anything changes, whether setup makes the bridge or finds one (`UPLINK_NOT_NETPLAN`). On a host Wisp runs on already, a host an earlier release bridged with NetworkManager or systemd-networkd's own files among them, an update then rolls back and a manual upgrade stops: Wisp stays on its release until netplan runs the network (settled 2026-11-20).
  - Server installs of both distributions run their network with netplan. ifupdown, which Debian's own installer sets up, is the next tool to support ([BACKLOG.md](../BACKLOG.md)).
  - netplan brings `python3`, which the plan reads the network's configuration with: setup has no prerequisite of its own.
  - Rejected: making the bridge through NetworkManager and plain systemd-networkd too, which had grown to half of setup and most of its refusals, for hosts Wisp does not target.
- **A bridge on the uplink**, which every VM and container joins. When the uplink already is a bridge, setup uses it and changes nothing in the network. Otherwise setup makes `br0` on it, for one shape of uplink (settled 2026-11-18): **a plain Ethernet interface, on DHCP or with a static address set in netplan, defined on its own**. For any other shape the operator makes the bridge with netplan, and setup then uses it.

**Every refusal names what was found, with its code** (settled 2026-11-19). The codes are in the style of [ERROR-HANDLING.md](ERROR-HANDLING.md)'s, so the row below is found by its code; `npm run check` keeps the codes the scripts print and this table's rows in step.

A refusal comes before anything changes: the install's before it changes anything, setup's before its second step, except `NETWORK_CHANGED_SINCE_PLAN`, which the bridge step makes before its first change (settled 2026-11-20).

| Id | Refused | What the operator does |
|---|---|---|
| `UNSUPPORTED_DISTRO` | Another distro | Use a supported host. |
| `SYSTEMD_TOO_OLD` | systemd older than 254 | Use a supported host. |
| `NO_DEFAULT_ROUTE` | No IPv4 default route | Give the host one. |
| `UPLINK_NOT_NETPLAN` | netplan, rendered by systemd-networkd, does not run the uplink; the message names what does, where setup can tell (NetworkManager, a systemd-networkd file of its own, ifupdown) | Run the uplink with netplan, rendered by systemd-networkd (renderer networkd). |
| `CLOUD_INIT_NETWORK` | When setup has to make the bridge: cloud-init still manages the network (installed, not switched off, and its configuration does not say `network: {config: disabled}`); a host whose uplink already is a bridge is not refused for it | Add the one documented line `network: {config: disabled}` in a file under `/etc/cloud/cloud.cfg.d/`. Nothing else: the netplan file cloud-init wrote is then the operator's, and setup edits it like any other (settled 2026-11-18). |
| `UPLINK_BOND`, `UPLINK_WIFI`, `UPLINK_VLAN`, `UPLINK_NOT_ETHERNET` | The uplink is a bond, Wi-Fi, a VLAN, or not a physical Ethernet interface (a tunnel) | Make the bridge with netplan. |
| `UPLINK_DEPENDENT` | A netplan definition hangs off the uplink, whatever its kind (its `link:` is the uplink's: a VLAN, a tunnel, an SR-IOV function), or holds it in its `interfaces:` (a bond, a VRF; a bridge is `NETPLAN_NOT_APPLIED`) | Make the bridge with netplan. |
| `UPLINK_NO_IPV4` | The uplink has no IPv4 address | Give it one. |
| `BRIDGE_NAME_TAKEN` | A `br0` that exists but does not carry the uplink | Remove it, or make it the bridge on the uplink with netplan. |
| `DHCP_NO_LEASE` | The uplink is on DHCP but has no lease | Let it get one (`networkctl renew <uplink>`). |
| `DHCP_LEASE_RECORD` | On systemd before 257: the uplink holds a DHCP lease, but systemd-networkd's record of it is missing or names no client identifier (see [The bridge](#the-bridge)) | Renew the lease (`networkctl renew <uplink>`). |
| `DHCP_CLIENT_ID_TYPE` | The lease's client identifier is neither the hardware address (type 1) nor a DUID (type 255) | Make the bridge with netplan. |
| `DNS_PORT_TAKEN` | Another DNS server on port 53 of `169.254.53.53` or of every IPv4 address (`0.0.0.0`, `*`, or a wildcard bound to one device) | Bind it to the addresses it serves. `[::]:53` (IPv6 only) is no conflict. |
| `NETPLAN_REJECTED` | netplan rejects the host's own configuration (`netplan generate` fails on it); the message quotes netplan's error | Correct it, so that `netplan generate` accepts it. |
| `NETPLAN_DNS_STUB` | netplan rejects the host's configuration once the container DNS stub's file (below) is added (a `wisp-dns0` of the operator's of another kind, a netplan without `dummy-devices`), or a device `wisp-dns0` that is not a dummy exists; the message quotes netplan's error | Remove that definition or device, or use a netplan that has `dummy-devices`. |
| `NETPLAN_NOT_APPLIED` | netplan's configuration and the live network disagree on the uplink's bridge: one is defined but not live, or live but not defined, so gone at the next boot | Defined but not live: apply netplan's configuration (`netplan apply`), or first put back the original kept under `/var/lib/wisp/network-before-bridge`. Live but not defined: the one line `netplan apply; ip link delete br0 2>/dev/null \|\| true` (`netplan apply` leaves `br0` in place); setup then makes the bridge. |
| `NETPLAN_NO_DEFINITION` | netplan has no definition for the uplink | Define the uplink in a file of your own under `/etc/netplan`. |
| `NETPLAN_OUTSIDE_ETC` | netplan reads the uplink's definition from a file outside `/etc/netplan` (`/lib/netplan`, `/run/netplan`) | Define the uplink in a file of your own under `/etc/netplan`. |
| `NETPLAN_LINK_FILE` | That file is a symbolic link, which the step would replace with a file | Make it the file itself. |
| `NETPLAN_SETTING` | The uplink's definition matches more than the uplink (another hardware address, a driver, a wildcard name), names a renderer other than networkd, or has a key setup neither moves to the bridge nor keeps on the port | For the match: match the uplink alone, by name (with its hardware address, if wanted). Otherwise make the bridge with netplan. |
| `NETPLAN_SHARED` | The definition's file shares a definition with another netplan file, which `netplan set` would write back merged | Make the bridge with netplan. |
| `NETPLAN_MERGED` | netplan rejects one of setup's edits (`netplan set`), or with them rejects the configuration it accepts without them (the message quotes netplan's error), or its merged configuration is not what setup wrote (another file adds to the uplink or the bridge) | Make the bridge with netplan. |
| `NETPLAN_DROPINS` | systemd-networkd runs the uplink from netplan's unit with drop-ins (`<unit>.d/*.conf`) | Put their settings in the netplan definition. |
| `NETWORKD_SECOND_FILE` | Another `.network` file than netplan's could take the uplink (settled 2026-11-19: exactly one definition, before as well as after); one whose name sorts after netplan's, such as an initrd's `zzzz-` catch-all, never does and is no conflict | Make it match only other interfaces, or remove it. |
| `NETWORK_CHANGED_SINCE_ASKED` | The network changed after the install asked: the plan would make another bridge, on another uplink or address, than the operator confirmed | Run the install again. |
| `NETWORK_CHANGED_SINCE_PLAN` | Something the plan read changed while setup ran: the default route, the uplink's addresses, hardware address or MTU, cloud-init's configuration, netplan's files, another definition that could take the uplink | Run setup again. |

## Install

As the user Wisp will run as (not root), with sudo, on the host — from a release tarball:

```
tar -xzf wisp-<version>.tar.gz
cd wisp
./scripts/install.sh [install-dir] [--server-name NAME]
```

or from a development machine, which stages the same release-shaped tarball (`scripts/stage-release.sh`) and runs that installer on the host: `scripts/push.sh user@host /opt/wisp`. Hosts never build: the tarball carries the prebuilt frontend. A fresh host needs only ssh, sudo and `tar`. The install directory defaults to `/opt/wisp`; it must be missing, empty, or a Wisp install already.

What is asked, all before anything changes (settled 2026-11-18):

1. sudo's password, once.
2. `Server name [<hostname>]:` and `Wisp password:` / `Confirm password:` (at least 6 characters, not `changeme`) — only when the install has none yet.
3. Only when the uplink has no bridge: `Create br0 on <uplink> (<address>), keeping its address? The connection may pause while it is applied. [Y/n]`. Declined, the install stops with "Wisp needs a bridge: make one on <uplink> with netplan, or let setup make it. Nothing was changed."

With no terminal on stdin:

- sudo must need no password; when it does, the install stops before any change, saying so.
- The password (when needed) is one line on stdin.
- The server name comes from `--server-name` and defaults to the host name.
- The bridge is made without asking.

Then the install works to the end unattended, in a process of its own that ignores a hangup, in the updater's order (settled 2026-11-19):

1. It works its plan out again from the tree it installs, and stops before any change if the network changed since the question.
2. It stops Wisp, when an install is running, and replaces the tree.
3. It runs [setup](#setup), which compares its own plan with the question once more.
4. It starts Wisp, waiting until it is ready.

- **The install has no rollback.** When setup fails, it says so, and that Wisp is stopped with the new tree in place, and to run the install again.
- **The log.** The install writes to `/tmp/wisp-install.<id>.log`, which the installer follows: removed when the install succeeds, kept and named when it fails. A dropped connection or Ctrl-C stops only the following.

One install, update or setup runs at a time: each takes `/run/wisp.lock` for its whole run.

## Setup

```
sudo <install-dir>/scripts/linux/setup/common-steps.sh <install-dir> <deploy-user>
```

The one list of steps the install and every update run, by path from the install tree (settled 2026-11-18).

- Every step checks first and changes only what is missing: a second run reports every step in place, starts no package manager and changes no file it owns.
- A step that fails stops the run with a non-zero exit and its name.
- The first step, `network-plan`, changes nothing: it works out the plan and makes the refusals above.
- The steps run without the install lock's descriptor: setup holds the lock, so a process a step leaves behind cannot keep updates locked.

**A stop** (TERM, INT) ends setup within its stop bound, whoever sent it; the bridge step's apply and its undo are never cut short (settled 2026-11-19: each step stops itself, knowing what of its work may be cut short; this replaced setup's TERM to the step's whole session).

Afterwards the host has:

- the packages Wisp uses (Node.js 24 and containerd 2 from their vendors' signed apt repos);
- the deploy user in the libvirt, kvm, input and containerd groups;
- Wisp's directories under `/var/lib/wisp` and `/mnt/wisp`;
- libvirt with its default NAT network not autostarting;
- containerd with Wisp's namespace;
- the CNI plugins and a bridge config for the uplink's bridge, with `cni-dhcp.service`;
- the container DNS stub (below);
- avahi with `publish-aaaa-on-ipv4=no`;
- the privileged `wisp-*` helpers and their sudoers rules;
- `wisp.service` rendered and enabled;
- the backend's dependencies;
- the install's answers, with `config/` secrets at 0600;
- the bridge, made last.

**The container DNS stub** (`wisp-dns0`, `169.254.53.53/32`) is a netplan definition in a file of Wisp's own, `/etc/netplan/90-wisp-dns0.yaml`, so it exists at every boot before Wisp starts, with nothing of Wisp's creating it; `wisp.service` has no `ExecStartPre` (settled 2026-11-20).

- netplan checks the file with the host's configuration before it goes live (`NETPLAN_DNS_STUB`).
- Setup renders it with `netplan generate`, never `netplan apply`, and reloads systemd-networkd only when nothing less brings the device to its settings: a reload reconfigures every link netplan renders, the bridge's DHCP lease among them.
- What the device needs is decided from what the host holds, never from what the run wrote, so a run cut short is finished by the next (settled 2026-11-20).
- The former declaration, systemd-networkd's own `10-wisp-dns0.netdev` and `.network`, is taken back by the same step.

Why the stub is declared so, on a device of its own: [CONTAINERS.md → Local DNS](CONTAINERS.md#local-dns-mdns).

## The bridge

(settled 2026-11-18)

**It keeps the host's address.**

- `br0` takes the uplink's hardware address and its whole layer 3:
  - on DHCP its client identifier, so the DHCP server hands it the same lease;
  - on a static address its addresses, routes, gateways, name servers and search domains.
- The uplink becomes its port with no addressing of its own. Its link settings (MTU, offloads, wake-on-LAN) stay on it.
- The bridge's definition sets the uplink's MTU on the bridge itself, so a port that joins at another MTU does not lower it (settled 2026-11-19).
- The bridge's definition names its renderer, networkd, on itself, whatever its file's, so systemd-networkd runs it (settled 2026-11-20).
- The bridge keeps the IPv4 address and the IPv6 addresses the uplink's netplan definition lists. Addresses the host gets by DHCPv6 or from router advertisements can change (settled 2026-11-20):
  - the DHCPv6 identity is pinned only when the DHCPv4 client identifier is a DUID (networkd's IAID, derived from the uplink's name, which the bridge would not have);
  - with a client identifier from the hardware address, the bridge's DHCPv6 identity is its own.

**The configuration moves** (settled 2026-11-19).

- After the step, netplan holds exactly one definition for the uplink, in the operator's file that defined it. It says "port of the bridge", with the uplink's link settings.
- The address configuration is in the bridge's definition, in the same file, and nowhere else.
- None of the operator's definitions is left dormant or shadowed, and none of setup's wins by sorting first.
- Rejected: adding only files of Wisp's own beside the operator's, untouched. Observed on a netplan host: every boot then waited two minutes for netplan's own `wait-online` drop-in, which names the uplink, and the operator's edits to the uplink in netplan applied silently to nothing.

**Only netplan's documented configuration** (settled 2026-11-20).

- The operator's file that defines the uplink is edited with `netplan set`, which rewrites it whole: comments and key order are not kept.
- netplan checks the whole configuration with the edits; what it checked goes live by one rename.
- For a DUID identity, a systemd-networkd drop-in on netplan's unit for the bridge pins the IAID, which netplan has no key for.

**One read of a tool's internal state** (settled 2026-11-20).

- Before systemd 257, `networkctl status --json` leaves out the DHCPv4 client identifier the bridge must send. On those hosts (Ubuntu 24.04 has systemd 255) the plan and the bridge's check read it, read only, from systemd-networkd's record of the lease, `/run/systemd/netif/leases/<ifindex>` (`CLIENTID=`). From 257 on they read it from the JSON.
- Which one is read is chosen by the systemd version (`systemctl --version`, read once with the supported-host check), never by a value missing from the JSON.
- A lease whose record or `CLIENTID=` is missing is refused (`DHCP_LEASE_RECORD`).
- Rejected: raising the floor to systemd 257, which drops Ubuntu 24.04; parsing `networkctl status`'s text, which is no more an interface than the record.

**Checked before, verified after, undone on failure.** Every change leaves a network that boots, old or new. Within 90 s after the apply the step checks, against what the uplink held (settled 2026-11-20):

- the bridge holds the uplink's hardware address, its IPv4 addresses and the IPv6 addresses its netplan definition lists, never one the host learned;
- on DHCP, also its default route's gateway, its name servers, and the client identifier it sends; on a static address, also its IPv4 routes, the IPv6 routes set for it, its name servers and search domains (name servers and search domains only where systemd-resolved runs, which holds them);
- the uplink holds none of those addresses, no IPv4 route and no IPv6 route set for it, is the bridge's port, and the bridge has carrier;
- systemd-networkd runs each from the unit netplan renders for it.

A failed apply or check undoes the bridge, and so does a stop.

**The original is kept before the first change** (settled 2026-11-20).

- The operator's netplan file the plan edits is copied to `/var/lib/wisp/network-before-bridge/<the step's UTC time>/etc/netplan/<file>`, never seen half made; the step says where. When it cannot be kept, the step changes nothing.
- After a bridge that passed its check, it stays. After an undo, it goes.

**The undo**, never cut short: the kept original goes back and is applied, and the step fails saying whether the uplink holds again what it held. When the undo does not complete, the original stays kept, and the message names it. A step that fails before it switches the operator's file takes back only what it wrote (settled 2026-11-20).

**The container DNS stub is waited for after the check** (settled 2026-11-20: the stub is no part of the bridge's check).

- From the check that passed, the step waits up to 30 s for the stub to hold its address, which an apply can drop for a while ([CONTAINERS.md → Local DNS](CONTAINERS.md#local-dns-mdns)), as the backend's start follows the step.
- When it does not, the step fails saying that the bridge is in place and kept and what brings the stub back (`networkctl reconfigure wisp-dns0`), and undoes nothing.

**A step that died** (a power cut, a kill) is not recovered (settled 2026-11-20). The next run plans from the host as it finds it: an uplink that is a bridge is used, one that is not gets its bridge. Two states between them are refused (`NETPLAN_NOT_APPLIED`), as setup applies nothing it did not check; its row says what brings each back:

- killed after its switch, before `netplan apply` finished: `br0` can be defined but not live;
- killed in its undo, after the original went back, before `br0` was deleted: `br0` is live but not defined.

A host left unreachable is fixed at the console, as root, from the newest directory under `/var/lib/wisp/network-before-bridge`:

1. `cp -a /var/lib/wisp/network-before-bridge/<newest>/etc/netplan/<file> /etc/netplan/`
2. `rm -f /etc/systemd/network/10-netplan-br0.network.d/50-wisp-dhcp-identity.conf`
3. `ip link delete br0 2>/dev/null || true` (it may be gone already)
4. `netplan apply`

The next run of setup then makes the bridge again.

**An update makes the bridge on a host that has none** — a host installed before setup made bridges — through the same step, from `wisp-updater.service`, so the update goes on while the address moves to the bridge, and completes and reports done.

## Manual upgrade

Run the new release's installer over the install: from its tarball (`./scripts/install.sh <install-dir>`) or with `scripts/push.sh`. It asks nothing that the install already has, runs setup and restarts Wisp. There is no "git checkout on the server" path (settled 2026-11-18).

## Operating Wisp

```
<install-dir>/scripts/wispctl.sh svc start|stop|restart|logs   # wisp.service through systemd
<install-dir>/scripts/wispctl.sh password --force              # set a new password
```

`svc start` and `svc restart` wait until the backend is ready, and on a failure print its last log lines.

## Systemd Service Unit

A single service unit in `systemd/linux/`:

### `wisp.service`

```ini
[Unit]
Description=Wisp
After=network-online.target libvirtd.service virtqemud.service containerd.service
Wants=network-online.target

[Service]
Type=notify
NotifyAccess=all
TimeoutStartSec=15min
User=WISP_USER
WorkingDirectory=WISP_PATH/backend
EnvironmentFile=-WISP_PATH/config/runtime.env
ExecStart=/usr/bin/node src/index.js
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=on-failure
RestartSec=5
RestartSteps=6
RestartMaxDelaySec=5min
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
```

`Type=notify`: the start ends when the backend reports itself ready (`systemd-notify --ready`) once it listens, after its state migrations and boot work, or fails when it exits first; `systemctl start` and `restart` wait for that, bounded by `TimeoutStartSec`. A failed start is retried with a delay growing from 5 s to 5 min ([UPDATES.md → Health-gated start](UPDATES.md#health-gated-start)).

`TimeoutStopSec=15`: on a stop the backend ends what it runs (its streams, subprocesses and connections) and exits within 15 s; past that, systemd kills it.

### SPA serving

In production, the same Node process serves the prebuilt SPA from `frontend/dist/` (and `/vendor/*` from `frontend/public/vendor/` for noVNC). `@fastify/static` is registered after the `/api` and `/ws` route trees; an `onSend` hook adds CSP + `X-Content-Type-Options` + `X-Frame-Options` + `Referrer-Policy` headers; `setNotFoundHandler` returns `dist/index.html` for non-`/api` / non-`/ws` paths so client-side routing survives deep-link refresh. The auth hook bypasses non-API/WS paths so the bundle and login page load without a session — `/api/*` still requires the JWT cookie.

### Placeholder substitution

Setup's `service-unit` step substitutes `WISP_USER` and `WISP_PATH` into `systemd/linux/wisp.service`, installs it as `/etc/systemd/system/wisp.service` and enables it.

## Developer Workflow

### Local development

Development is local only *(settled 2026-11-12)*: the backend and the Vite dev server run on the same machine, and on macOS the backend runs its stub managers. Manager paths are verified on a Linux host through a dev deploy (`scripts/push.sh`), not by running the dev backend there.

1. Run the backend: `cd backend && NODE_ENV=development npm run dev` (uses `--watch` for auto-reload). In development it listens on **`127.0.0.1`** only (`WISP_PORT`, default 8080); production listens on every interface.
2. Run the frontend: `cd frontend && npx vite --port 5173`
3. The Vite dev server at `localhost:5173` proxies `/api` and `/ws` to `127.0.0.1:8080`

Backend enables CORS for `localhost:5173` when `NODE_ENV=development`.

On macOS, the backend starts without connecting to libvirt (dev mode) — VM operations are unavailable but the server starts.

## Releases (maintainers)


```bash
# Edit CHANGELOG.md (add a new "## YYYY-MM-DD" section at the top), do NOT commit it.
./scripts/release.sh 1.0.6        # bumps versions + retitles CHANGELOG + folds it into a single release commit + tags v1.0.6
git push && git push origin v1.0.6
```

`release.sh` accepts `CHANGELOG.md` as the only dirty file in the working tree, so the new section lands in the same `release: vX.Y.Z` commit as the version bumps — no separate changelog commit needed.

The `v1.0.6` tag triggers `.github/workflows/release.yml`, which runs `npm run check` (a failure stops it before anything is published), builds the frontend, packages `wisp-1.0.6.tar.gz` (with prebuilt `frontend/dist/`) plus a `.sha256`, extracts the matching CHANGELOG section as release notes, and creates the GitHub Release. Tags shaped `v*-*` (e.g. `v1.0.6-rc.1`) are published as prereleases — these are not surfaced by the in-app auto-checker (GitHub's `releases/latest` endpoint excludes prereleases).

## Helper Scripts

### Privileged helpers checklist (maintainers)

When you add a new **`backend/scripts/wisp-*`** script that the app runs via **`sudo -n`**:

1. **Register it** in **`scripts/linux/setup/install-helpers.sh`**: its name in `HELPERS`, which installs it and its sudoers rule; a package it runs goes in the packages step's list (`scripts/linux/setup/packages.sh`).
2. **Backend** — Prefer **`/usr/local/bin/<name>`** first, then bundled `backend/scripts/`, with an optional env override (match `host/linux/osUpdates.js` / `host/linux/hostPower.js` / `host/linux/hostHardware.js` patterns). A bundled fallback is exec'd directly (as root; `sudo -n` only matches the installed path), so commit the script executable (`git update-index --chmod=+x`), and resolve the path from the module's own location to `backend/scripts/` — `npm run check-imports` flags a `resolve(__dirname, …)` target that doesn't exist.
3. **Docs** — `docs/specs/DEPLOYMENT.md` (this section), `docs/specs/API-<AREA>.md` / `CONFIGURATION.md` as appropriate; the CLI tools inventory in `docs/TECH-STACK.md`; the **shell-exec allowlist in `docs/CODING-RULES.md` §7**.
4. **Install / upgrade** — Covered automatically if step 1 is done: setup's `helpers` step runs `install-helpers.sh` on every install and update.

### `wisp-os-update` (installed to `/usr/local/bin/`)

OS package update helper invoked via `sudo`, with apt:

| `check` | `upgrade` |
|---------|-----------|
| `apt-get update` + `apt-get -s dist-upgrade` (dry-run count) | `apt-get update && apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold dist-upgrade` |

Non-interactivity and the conffile policy are part of the OS Updates contract in [HOST-MONITORING.md](HOST-MONITORING.md#os-updates). The helper sets its own environment (`DEBIAN_FRONTEND=noninteractive`, `NEEDRESTART_MODE=a`, `UCF_FORCE_CONFFOLD=1`) because sudo's `env_reset` drops the caller's.

| Command | Description |
|---------|-------------|
| `wisp-os-update check` | Sync package DB, count upgradable packages (prints one integer) |
| `wisp-os-update list` | Sync package DB, print `PKG<TAB>name<TAB>from<TAB>to` lines plus `TOTAL <bytes>` (the op the backend uses for check and list) |
| `wisp-os-update upgrade` | Sync package DB and perform a full non-interactive upgrade |

The backend invokes **`/usr/local/bin/wisp-os-update`** only. Setup's `helpers` step installs it and configures sudoers. If the file is missing, OS update APIs return 503 `UPDATE_CHECK_UNAVAILABLE`.

#### Troubleshooting: OS update check not working

1. **Backend logs** — 503 responses include `detail` (often sudo/package manager stderr).
2. **Path** — Confirm `/usr/local/bin/wisp-os-update` exists and setup completed its `helpers` step.
3. **Privilege** — `/etc/sudoers.d/wisp-os-update` should allow: `<deploy_user> ALL=(root) NOPASSWD: /usr/local/bin/wisp-os-update`. Test: `sudo -n /usr/local/bin/wisp-os-update check`.
4. **Package manager** — Network and apt sources must work.

### `wisp-mount` (installed to `/usr/local/bin/`)

Unified mount helper for SMB shares and adopted removable drives. Invoked via `sudo`:

| Command | Description |
|---------|-------------|
| `wisp-mount smb mount <configPath>` | Mount an SMB share (config file supplies share, mountPath, username, password, uid, gid, optional `ownerOnly=1` → `file_mode=0600,dir_mode=0700`) |
| `wisp-mount smb check <configPath>` | Test SMB connectivity by mounting then unmounting |
| `wisp-mount disk mount <configPath>` | Mount an adopted removable drive by UUID (config file supplies uuid, mountPath, fsType, readOnly, uid, gid) |
| `wisp-mount unmount <path>` | Unmount a mount point |
| `wisp-mount unmount-lazy <path>` | Lazy-unmount (`umount -l`) for surprise-removed devices |
| `wisp-mount rmdir <path>` | Remove an empty mount-point directory (delete flow only) |

Every path must sit strictly under `/mnt/wisp/`; mount paths may not contain symlinked components, and `unmount*` acts only on paths listed in `/proc/self/mounts` (otherwise `not mounted`, exit `32`). Rules and rationale: [STORAGE.md — Privileged helper](STORAGE.md#privileged-helper).

Requires `cifs-utils`. The backend writes a temp config file (mode `0600`) per operation, invokes `wisp-mount` via `sudo -n`, then removes the config file. The helper also deletes the config file after use.

### `wisp-dmidecode` (installed to `/usr/local/bin/`)

Reads SMBIOS memory devices (`dmidecode --type 17`) and prints JSON for Host Overview RAM modules. Invoked via `sudo -n` as the deploy user.

The backend tries **`/usr/local/bin/wisp-dmidecode`** first (after server setup), then the bundled script under `backend/scripts/` if `WISP_DMIDECODE_SCRIPT` is unset. Setup installs the helper, installs the `dmidecode` package, and adds `/etc/sudoers.d/wisp-dmidecode` so `sudo -n /usr/local/bin/wisp-dmidecode` succeeds.

If the array is empty in the API: helper missing, sudoers not configured, `dmidecode` unavailable, or a VM/guest with no useful DMI (expected).

#### Troubleshooting: RAM modules not listed

1. **Test** — As deploy user: `sudo -n /usr/local/bin/wisp-dmidecode` should print JSON `[...]`. Compare with **`dmidecode --type 17`** (not the full `dmidecode` dump): each populated slot should have a numeric **Size** line (`MB`/`MiB`/`GB`/`GiB`).
2. **Re-run setup** ([Setup](#setup)) so `/usr/local/bin/wisp-dmidecode` matches the version in `backend/scripts/`.
3. **DMI** — Some environments expose no DIMM entries; live usage stats still come from `/proc`.

### `wisp-smartctl` (installed to `/usr/local/bin/`)

Reads per-disk SMART summaries for `GET /api/host/hardware` by running `smartctl --json -a /dev/<disk>` and returning JSON to the backend. Invoked via `sudo -n` as the deploy user.

The backend tries **`/usr/local/bin/wisp-smartctl`** first (after server setup), then the bundled script under `backend/scripts/` if `WISP_SMARTCTL_SCRIPT` is unset. Setup installs the helper and `/etc/sudoers.d/wisp-smartctl`; package install ensures `smartmontools` is present.

If SMART fields are unavailable in the API for a disk, the backend keeps the disk row and returns `smart.supported: false` with a per-disk `smart.error`.

### `wisp-power` (installed to `/usr/local/bin/`)

Runs `shutdown -h now` or `shutdown -r now` for Host panel power actions. Invoked via `sudo -n` as the deploy user.

The backend tries **`/usr/local/bin/wisp-power`** first, then the bundled `backend/scripts/wisp-power`, unless `WISP_POWER_SCRIPT` is set. Setup installs the helper and `/etc/sudoers.d/wisp-power`.

**Troubleshooting:** As deploy user, `sudo -n /usr/local/bin/wisp-power` should print usage and exit 1 if sudoers allow the script (do not pass `shutdown`/`reboot` except on a host you intend to power off). Confirm `/etc/sudoers.d/wisp-power`: `<deploy_user> ALL=(root) NOPASSWD: /usr/local/bin/wisp-power`.

### `wisp-nvram` (installed to `/usr/local/bin/`)

Privileged copy of a UEFI NVRAM file (`VARS.fd`). libvirt creates `<vmDir>/VARS.fd` as `libvirt-qemu:kvm` mode `600`; the deploy user is in the `kvm` group but mode `600` only grants the owner read access — group membership doesn't help. Without the helper, **clone** of a UEFI VM fails with `EACCES`, and **backup**/**restore** silently drop NVRAM state (boot order, Secure Boot enrolled keys, custom NVRAM settings).

| Command | Description |
|---------|-------------|
| `wisp-nvram copy <src> <dst>` | `cp -p` then chown destination to the invoking user (`SUDO_UID`/`SUDO_GID`). libvirt's `dynamic_ownership=1` reclaims ownership when the restored VM is started. |

**Path validation:** Both paths must be absolute, basename must be `VARS.fd`, and after `realpath -m` both must sit under `/var/lib/wisp/` or `/mnt/wisp/`. Custom `vmsPath` / `backupLocalPath` outside these roots are not supported by the helper — keep backup destinations under `/var/lib/wisp/backups/` or use a Wisp-managed mount under `/mnt/wisp/`.

The backend invokes `sudo -n /usr/local/bin/wisp-nvram copy ...` from `vmManager` (backup, restore). `install-helpers.sh` installs the helper and `/etc/sudoers.d/wisp-nvram`.

### `wisp-netns` (installed to `/usr/local/bin/`)

Creates or removes a network namespace under `/var/run/netns/<name>` using `mkdir -p` and `ip netns add|delete`. The backend runs as the deploy user and cannot create that directory or netns without privilege; it invokes **`sudo -n /usr/local/bin/wisp-netns add|delete <name>`**.

| Arguments | Description |
|-----------|-------------|
| `add <name>` | Ensure netns exists (idempotent if bind mount already present) |
| `delete <name>` | Best-effort `ip netns delete` |
| `ipv4 <name> [ifname]` | Print `ip -4 addr show dev <ifname>` inside the netns (default `eth0`). Used to persist DHCP-assigned addresses when the CNI ADD result has no `ips[]`. |
| `route-add <name> <ifname> <ipv4>` | `ip -n <name> route replace <ipv4>/32 dev <ifname>` — installs an on-link /32 route inside the container's netns so Wisp's DNS forwarder stub IP (`169.254.53.53`) is reachable via the veth instead of being sent to the LAN gateway and black-holed. |

**Troubleshooting:** `EACCES` on `mkdir '/var/run/netns'` in backend logs → helpers not installed or sudoers missing. Run [setup](#setup). Test: `sudo -n /usr/local/bin/wisp-netns add wisp-netns-test` then `sudo -n /usr/local/bin/wisp-netns delete wisp-netns-test`. Every install and update reinstalls the helpers (setup's `helpers` step), so **`wisp-netns ipv4`** and **`wisp-netns route-add`** always match the backend.

### `wisp-cni` (installed to `/usr/local/bin/`)

Runs a single CNI plugin binary from `/opt/cni/bin` with config JSON read from a temp file, setting `CNI_COMMAND`, `CNI_CONTAINERID`, `CNI_NETNS`, `CNI_IFNAME`, `CNI_PATH`. Used for bridge **ADD** / **DEL** so the deploy user does not need ambient `CAP_NET_ADMIN` on the Node process.

**Usage (do not run by hand unless debugging):** `wisp-cni ADD\|DEL <plugin_basename> <container_id> <netns_path> <config.json> [<cni_bin_dir>]`.

- **Bin dir is pinned** to `/opt/cni/bin` inside the helper (where `cni.sh` installs the plugins) and exported as `CNI_PATH`. The optional 6th argument is the backend's view of that dir (`WISP_CNI_BIN_DIR`, default `/opt/cni/bin`); any other value is refused, so an override fails loudly rather than letting the caller pick which binaries run as root. (settled 2026-10-16: the arg stays in the contract — a helper refreshed by the updater and the still-running old backend agree on it, and no backend change is needed.)
- **Plugin** — bare name matching `^[a-z0-9-]+$`, resolved with `realpath` and confined under the (resolved) bin dir.
- **Config file** — absolute path to a regular file **owned by the invoking user** (`SUDO_UID`, or root without sudo). The helper opens it once and checks the open descriptor, so it can't be swapped between check and use; the plugin never reads a file the caller couldn't already read.

**Troubleshooting:** If container start returns 200 but the task exits or CNI errors appear in logs:

1. **Plugin stdin** — The backend merges top-level `cniVersion` and `name` from the `.conflist` into each `plugins[]` entry before invoking the bridge plugin (a raw plugin fragment alone is invalid).
2. **Binaries** — `/opt/cni/bin/bridge` and `/opt/cni/bin/dhcp` exist (`scripts/linux/setup/cni.sh`).
3. **DHCP daemon** — For `ipam.type: dhcp`, **`cni-dhcp.service`** must be active (`systemctl status cni-dhcp`). If it is down, bridge ADD fails to obtain an IP.
4. **Bridge interface** — `bridge` must name an existing Linux bridge on the host (e.g. `br0` or a managed VLAN bridge such as `br0-vlan10`). The backend asserts `/sys/class/net/<iface>/bridge` exists before every CNI ADD; otherwise ADD is refused with `CONTAINERD_ERROR`. If the default route is not via a bridge, run setup (`sudo <install-dir>/scripts/linux/setup/common-steps.sh <install-dir> <deploy-user>`), which makes `br0` and writes the CNI configuration for it.
5. **Sudoers** — `sudo -n /usr/local/bin/wisp-cni` succeeds as the deploy user.

### `wisp-bridge` (installed to `/usr/local/bin/`)

Manages Host Mgmt VLAN-tagged bridges through netplan and is invoked via `sudo -n` by the backend host routes.

| Command | Description |
|---------|-------------|
| `wisp-bridge create-vlan-bridge --base <bridge> --vlan <id> --name <bridgeName> --file-name <name>.yaml` | Write managed netplan VLAN+bridge file and run `netplan apply` |
| `wisp-bridge delete-vlan-bridge --base <bridge> --vlan <id> --name <bridgeName> --file-name <name>.yaml` | Remove managed netplan file, detach live links (`nomaster`), delete bridge+vlan interfaces, then run `netplan apply` |

The helper writes/removes only Wisp-managed files in `/etc/netplan` (`91-wisp-vlan__*`) and leaves unrelated netplan config untouched.

`--file-name` is validated against the regex `^91-wisp-vlan__[a-zA-Z0-9._-]+__[0-9]+__[a-zA-Z0-9._-]+\.yaml$` and the resolved path (`realpath -m`) must remain inside `/etc/netplan/`. This is defense-in-depth: it stops a future caller bug from turning the helper into an arbitrary-root-write primitive.

Parent safety checks are enforced in both backend and helper:

- parent must be an existing Linux bridge
- parent must not be VLAN-tagged
- parent must have at least one non-VLAN member interface

### `wisp-updater` (installed to `/usr/local/bin/`, run via `wisp-updater.service`)

Atomic-swap applier for the Wisp self-update pipeline. Not invoked directly — the backend triggers `wisp-updater.service` (a `Type=oneshot` systemd unit) via `sudo -n /usr/bin/systemctl start --no-block wisp-updater.service`. The unit's `WISP_INSTALL_DIR` env var is templated at install time; the staging path is read from `/var/lib/wisp/updates/target` (single line, must start with `/var/lib/wisp/updates/staging-`). See [UPDATES.md](UPDATES.md) for the full pipeline.

| Operation | Description |
|---------|-------------|
| `systemctl start --no-block wisp-updater.service` | Stop service → snapshot install to `<install>.prev/` → rsync staging into install (preserving `config/wisp-config.json`, `wisp-password`, `runtime.env`, `backup-status.json`, `migrations.json`, `.pids`, `.logs`) → run the new tree's setup (the backend's dependencies, the `wisp-*` helpers, their sudoers rules, `wisp.service`) → start service. Auto-rolls back from `<install>.prev/` on any failure ([UPDATES.md → Rollback](UPDATES.md#rollback)). |

Steps are echoed to journald (`journalctl -u wisp-updater.service`) — Wisp does not capture them since it dies during `step:stop-service`.

### `vendor-novnc.sh`

See [noVNC.md](noVNC.md). Fetches the pinned noVNC release from GitHub and copies `core/` and `vendor/` into the frontend's public directory; the frontend's `npm run build` runs it first.

## Config directory (`config/`)

| File | Tracked | Purpose |
|------|---------|---------|
| `runtime.env.example` | Yes | Optional process overrides template |
| `runtime.env` | No | Optional active overrides |
| `wisp-config.json.example` | Yes | Application settings template |
| `wisp-config.json` | No | Settings (UI) |
| `wisp-password` | No | Scrypt hash for login / JWT secret |
| `migrations.json` | No | State-migration ledger — which migration ids ran on this host ([UPDATES.md](UPDATES.md#ledger-configmigrationsjson)) |
