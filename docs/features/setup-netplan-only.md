# Setup: netplan only, and no crash journal

A cut of phase 7's "one setup path" (`docs/reviews/2026-11-17/IMPLEMENTATION.md`), decided
by the user on 2026-11-20: setup's network part had grown to about half of setup and all
but a handful of its 54 refusals, for hosts and failures that do not matter to Wisp.

## What it is for

Wisp targets server distributions, Ubuntu and Debian for now. Their servers run the
network with netplan. Setup makes the bridge there, and nowhere else. Desktops
(NetworkManager) and hosts on plain systemd-networkd are refused. A power cut in the middle
of the bridge step is no longer recovered by the next run.

## Decisions

### Hosts

- **A supported host's network is run by netplan**, rendered by systemd-networkd. This
  holds whether setup makes the bridge or finds one: a host run by another tool is
  refused before anything changes, bridge or not.
- **Refused with one code and one remedy**, "run the uplink with netplan (renderer
  networkd)": NetworkManager, plain systemd-networkd, ifupdown, and anything else. The
  message names what was found to run the uplink, where setup can tell.
- **Everything of setup's that served only the two cut tools goes**: their plans, their
  bridge and undo paths, their refusals and rows, their Python and its tests, the
  NetworkManager variant of the container DNS stub. Nothing is kept "for later".
- **ifupdown is the next tool to support, not now.** It is what Debian's own installer sets
  up on a server, and it is common across distributions. `docs/BACKLOG.md` holds it.
- The rest of the supported shape stays: Debian or Ubuntu, systemd 254 or newer, an IPv4
  default route, a plain Ethernet uplink on DHCP or a static address, defined on its own.

### The bridge step

- **Kept**: the plan and its refusals before any change; the configuration moves to the
  bridge, through netplan; the same address and DHCP lease; the check after the apply; the
  undo when the check fails or the step is stopped; the originals kept under
  `/var/lib/wisp/network-before-bridge`.
- **Kept**: a file goes live by one rename, so a cut leaves the old file or the new one,
  never half of one.
- **Gone: the recovery from a step that died** (a power cut, a kill). No journal directory,
  no journal format version, no `bridge-journal` step, no classification of what a dead
  step left, no question the installer asks from a journal, no `JOURNAL_*` refusals.
- **After a step that died**, the next run plans from the host as it finds it: an uplink
  that is a bridge is used, one that is not gets its bridge. A host left unreachable is
  fixed at the console from the kept original, with one netplan command. `DEPLOYMENT.md`
  says how, in a few lines.
- The originals are therefore kept before the first change, not at the end.

### What follows from these

- The updater's bounds are computed again without the recovery's times.
- `npm run check` loses the journal format check. The refusals check stays.
- The builder says, as an open point, whether the container DNS stub is then declared
  through netplan too, so that Wisp writes one tool's files, and what that means for a
  host that holds the stub's present files.

## What it changes in the docs

- `specs/DEPLOYMENT.md`: Supported hosts, the refusals table, The bridge (the per-tool
  parts, the journal, the recovery at the console), and what a manual upgrade and an
  update say about them.
- `specs/UPDATES.md`: the bounds, where they change. `specs/CONTAINERS.md`: the stub's
  declaration, where it names NetworkManager.
- `README.md`, the install section. `PRODUCTION.md` and `TECH-STACK.md`, where they name
  the tools or the journal.
- `BACKLOG.md`: the entries about NetworkManager and plain systemd-networkd hosts are
  removed or rewritten for netplan-only hosts ("VLAN bridges are netplan's only" among
  them).

## Constraints

- A build from scratch for netplan alone: no dispatch by tool with one tool left, no
  parameter that only ever takes one value, no shared layer that exists for three.
- The released versions never had the journal, so nothing is cleaned up for it.
- **Released hosts that are not netplan hosts stop updating** (corrected 2026-11-20: this
  doc first said the releases never made the cut tools' bridges; they did). Up to
  v2.8.0-beta.1, setup made `br0` with `nmcli`, or with systemd-networkd's files, on a
  host without netplan. On such a host the next update is refused and rolls back, and the
  host stays on its release until netplan runs its network. Nothing migrates such a
  host: moving a network between tools is the operator's. The changelog says so.
- The test host's limits are unchanged. It is a netplan host with a bridge: a deploy
  leaves its network record as it was.

## Milestones

### 1. Netplan only

Acceptance, in throwaway VMs on the test host unless said otherwise:

- A fresh install on Ubuntu 26.04, on Ubuntu 24.04 and on a Debian 13 cloud image, each on
  DHCP, ends with `br0` holding the address the uplink had, and a VM or container on it
  gets an address from the LAN. One of them is repeated with a static address.
- A host whose uplink NetworkManager runs, and one on plain systemd-networkd, are each
  refused with their code before anything on the host changes, with and without a bridge.
- No file under `scripts/` names `nmcli` or a NetworkManager path, outside the detection
  that refuses it.
- `npm run check` passes, and every refusal code the scripts print has its row.

### 2. No crash journal

- A bridge step whose check is made to fail undoes, and the host holds what it held
  before. The same for a step stopped with TERM.
- A step killed with KILL after its apply: the next run of setup finds the bridge and
  uses it. A step killed before its apply: the next run makes the bridge.
- The console recovery written in `DEPLOYMENT.md` is run once as written, on a host put
  in that state, and brings back the former network.
- An update on a host without a bridge makes it and reports done.
- No file under `scripts/` reads or writes a bridge journal. `npm run check` passes with
  the bounds computed again.
- A deploy to the test host leaves its network record identical.

## Not in this feature

- ifupdown hosts (backlog).
- The helpers feature of phase 7 (P-6, P-7).
