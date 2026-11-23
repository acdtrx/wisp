# Deployment

Wisp runs directly on a Linux server as a single systemd service — never in a container. One Node process serves the API and the prebuilt SPA. This document is the contract for installing Wisp, for setup (what the install and every update run), and for a manual upgrade: what the operator runs, what is asked, and what the host looks like afterwards. How an update from the UI works is [UPDATES.md](UPDATES.md).

## Supported hosts

(settled 2026-11-18)

- **Debian or Ubuntu** (or a derivative that names one of them in `ID_LIKE`) with **systemd 254 or newer** (Debian 13, Ubuntu 24.04 and later; read from `systemctl --version`, not from the release number: the unit's restart backoff needs it). Arch Linux is dropped as a host; it stays as a guest.
- **KVM is not required** (settled 2026-11-19).
  - A host that can run only containers is still a useful Wisp host. Rejected: refusing a host without `/dev/kvm`.
  - Setup sets up VMs and containers alike on every host, so turning KVM on later needs nothing reinstalled.
  - On a host without `/dev/kvm` the run succeeds, and setup's last lines say that the host cannot run VMs, why, and how to turn virtualization on (the firmware's setting, or nested virtualization when the host is itself a VM; then a reboot). The installer ends with them too; in the update's log they close setup's part, before the install's start phase and the updater's `step:done`.
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

Run the new release's installer over the install: from its tarball (`tar -xzf wisp-<version>.tar.gz`, `cd wisp`, `./scripts/install.sh <install-dir>`, as the user Wisp runs as) or with `scripts/push.sh`. It asks nothing that the install already has (sudo's password, and the bridge question only on a host that has none), keeps everything in `config/`, runs setup and restarts Wisp; workloads keep running through it. This is also how a host on v2.8.0-beta.1 or older comes to a later release, once ([UPDATES.md](UPDATES.md#an-update-is-an-install-with-a-way-back)). Observed 2026-11-23 on two such hosts: 19 s with nothing asked on one that had a bridge, a running container kept its address; on one without a bridge whose network cloud-init manages, the install refused before any change (`CLOUD_INIT_NETWORK`) with the fix in its message (`echo "network: {config: disabled}" | sudo tee /etc/cloud/cloud.cfg.d/99-disable-network-config.cfg`), then asked the bridge question and took 41 s. There is no "git checkout on the server" path (settled 2026-11-18).

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
# then push the release commit and the tag to each remote: release.sh prints the commands.
# The tag on `github` starts the release workflow.
```

`release.sh` accepts `CHANGELOG.md` as the only dirty file in the working tree, so the new section lands in the same `release: vX.Y.Z` commit as the version bumps — no separate changelog commit needed.

The `v1.0.6` tag triggers `.github/workflows/release.yml`, which runs `npm run check` (a failure stops it before anything is published), builds the frontend, packages `wisp-1.0.6.tar.gz` (with prebuilt `frontend/dist/`) plus a `.sha256`, extracts the matching CHANGELOG section as release notes, and creates the GitHub Release. Tags shaped `v*-*` (e.g. `v1.0.6-rc.1`) are published as prereleases — these are not surfaced by the in-app auto-checker (GitHub's `releases/latest` endpoint excludes prereleases).

## Helper Scripts

### Privileged helpers checklist (maintainers)

When you add a new **`backend/scripts/wisp-*`** script that the app runs via **`sudo -n`**:

0. **Write it in the helpers' dialect** ([CODING-RULES §12](../CODING-RULES.md), Shell), with a test of its refusals in `backend/scripts/test/`.
1. **Put it in `backend/scripts/`**, executable, with a shebang: the helpers are that folder (every `wisp-*` script there but the updater; the shell check holds the folder to helpers, the updater and the shared file), and setup installs each with its sudoers rule. A package it runs goes in the packages step's list (`scripts/linux/setup/packages.sh`).
2. **Backend** — call it through the one runner, `runPrivileged(helperPath('wisp-<name>'), args, { timeoutMs })` from `lib/base/` (settled 2026-11-22). A helper is only ever **`/usr/local/bin/<name>`**, the path its sudoers rule names, run with `sudo -n` and a time bound. There is no bundled fallback, no env override and no direct run as root: the service never runs as root, and sudo refuses any other path. The runner tells a failure apart as `missing` (not installed: run setup), `refused` (sudo did not let the service run it), `timed-out`, or by the helper's own exit code `invalid`, `not-found`, `busy` or `failed`; the caller keeps its own error code on the wire. The fence check refuses a `'sudo'` anywhere else.
3. **Docs** — `docs/specs/DEPLOYMENT.md` (this section), `docs/specs/API-<AREA>.md` / `CONFIGURATION.md` as appropriate; the CLI tools inventory in `docs/TECH-STACK.md`; the **shell-exec allowlist in `docs/CODING-RULES.md` §7**.
4. **Install / upgrade** — Covered automatically if step 1 is done: setup's `helpers` step runs `install-helpers.sh` on every install and update.

### The helpers

Every helper is written in one dialect ([CODING-RULES §12](../CODING-RULES.md), Shell;
settled 2026-11-22): called as `wisp-<name> <subcommand> <arguments in order>`, the answer
on stdout, an error as one line on stderr, and the same exit codes in all of them (`0`
done, `64` wrong argument, `2` not there, `75` busy, `1` anything else). Each checks every
argument before it runs anything, and bounds each command that can hang. The shared parts
are in `wisp-helper-lib.sh`, installed beside them. Setup's `helpers` step installs them
all, with one sudo rule each (`<deploy_user> ALL=(root) NOPASSWD: /usr/local/bin/<name>`),
at every install and update.

**Setup installs exactly the set** (settled 2026-11-22). Every entry named `wisp-*` in
`/usr/local/bin` and in `/etc/sudoers.d` is setup's: each run installs this release's
helpers, the shared file, the updater and their rules, and then removes any other
`wisp-*` it finds in the two folders, naming each. So a helper a release stops shipping
goes at the update, with its rule, and a rollback removes what the failed release added
(from the release after this one: the first rollback goes back to a setup without the
sweep). The removal comes last, a rule before its file, so a step that fails half way
has removed nothing. A file of your own with that prefix in those folders is removed
too. Before, nothing was ever removed but two old helpers on a list that never ended.

**A release is installed by the release before it** (settled 2026-11-22). The updater that applies an update is the one already on the host. From this release on it reads one thing from the new tree: `scripts/linux/install-tree.sh`, with its four arguments and its exit `0` ([UPDATES.md → An update is an install with a way back](UPDATES.md#an-update-is-an-install-with-a-way-back)). That contract stays stable; everything else in a tree may change. Releases up to v2.8.0-beta.1 had an updater that read a list of files from the new tree (the backend's version, a port reader, setup's entry point, the unit template); none of that is kept for them (the user's choice, 2026-11-23), so such a host is updated once by hand ([Manual upgrade](#manual-upgrade)).

| Helper | Calls | What it does |
|--------|-------|--------------|
| `wisp-os-update` | `list`, `upgrade` | `list`: syncs the package lists and prints `PKG<TAB>name<TAB>from<TAB>to` lines plus `TOTAL <bytes>`. `upgrade`: a full non-interactive upgrade (`dist-upgrade`, keeping changed config files); progress on stderr. A package lock held elsewhere is exit 75. It sets its own environment (`DEBIAN_FRONTEND=noninteractive`, `NEEDRESTART_MODE=a`, `UCF_FORCE_CONFFOLD=1`), because sudo drops the caller's. The contract is [HOST-MONITORING.md → OS updates](HOST-MONITORING.md#os-updates) |
| `wisp-mount` | `smb-mount <share> <path> <credentials-file\|guest> <owner-only\|shared>`, `smb-check <share> <path> <credentials-file\|guest>`, `disk-mount <uuid> <path> <fstype> <ro\|rw>`, `unmount <path>`, `unmount-lazy <path>`, `rmdir <path>` | Mounts SMB shares and adopted removable drives under `/mnt/wisp/`. Rules: [STORAGE.md → Privileged helper](STORAGE.md#privileged-helper). Needs `cifs-utils` |
| `wisp-dmidecode` | (no argument) | The RAM modules (`dmidecode --type 17`) as a JSON array; `[]` only when DMI lists none (a VM, usually) |
| `wisp-smartctl` | `<disk>` | One disk's SMART data as smartctl's JSON; a disk in standby answers `{"standby":true}` and is not woken |
| `wisp-power` | `shutdown`, `reboot` | `shutdown -h now` / `shutdown -r now` |
| `wisp-nvram` | `copy <src> <dst>` | Copies a UEFI variables file (`VARS.fd`), which libvirt keeps readable by its own user only, and gives the copy to the service user. Both paths must be `VARS.fd` under `/var/lib/wisp/` or `/mnt/wisp/`, with no symbolic link on the way; the copy is written beside the target and renamed over it. A `vmsPath` or backup destination outside those folders is not supported |
| `wisp-netns` | `add <container>`, `delete <container>`, `route-add <container> <ifname> <ipv4>` | The container's network namespace, `/var/run/netns/<container>`, and the on-link route to Wisp's DNS stub inside it |
| `wisp-cni` | `add <container> <bridge> <mac>`, `del <container> <bridge>` | Runs the CNI `bridge` plugin (with the `dhcp` IPAM) for the container's own namespace. **The helper writes the network config itself** from its checked arguments and fixed settings (settled 2026-11-22): there is no network file on the host any more (`/etc/cni/net.d/10-wisp-bridge.conflist`, which setup now removes), and no caller can name another namespace, plugin or config. The plugin's result is the answer |
| `wisp-bridge` | `create <base-bridge> <vlan-id>`, `delete <base-bridge> <vlan-id>` | A VLAN bridge on a base bridge, through netplan: writes or removes only its own file in `/etc/netplan` (`91-wisp-vlan__…`) and runs `netplan apply`. The bridge's name, the VLAN interface and the file name are derived from the two arguments. The base must be a bridge, not itself VLAN-tagged, with a member that is not a VLAN |

**When a helper does not work**, the error on the page or in the journal says which of
four things happened: the helper is not installed, or sudo refused it (both: run setup,
[Setup](#setup)); it failed, with its own line; or it did not finish within its limit. To
try one by hand, as the deploy user: `sudo -n /usr/local/bin/wisp-dmidecode` (never
`wisp-power shutdown` on a host you mean to keep up). For container networking also check
that `/opt/cni/bin/bridge` and `/opt/cni/bin/dhcp` exist, that `cni-dhcp.service` is
active, and that the container's bridge is a bridge on the host.

### `wisp-updater` (installed to `/usr/local/bin/`, run via `wisp-updater.service`)

Applier for the Wisp self-update pipeline. Not invoked directly — the backend triggers `wisp-updater.service` (a `Type=oneshot` systemd unit) via `sudo -n /usr/bin/systemctl start --no-block wisp-updater.service`. The unit's `WISP_INSTALL_DIR` env var is templated at install time; the staging path is read from `/var/lib/wisp/updates/target` (single line, must start with `/var/lib/wisp/updates/staging-`). See [UPDATES.md](UPDATES.md) for the full pipeline.

| Operation | Description |
|---------|-------------|
| `systemctl start --no-block wisp-updater.service` | Stop service → keep a copy of the install at `<install>.prev/` → run the staged tree's own install (`scripts/linux/install-tree.sh`: the copy by the keep rule, setup, the start). Auto-rolls back from `<install>.prev/` on any failure ([UPDATES.md → Rollback](UPDATES.md#rollback)). |

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
