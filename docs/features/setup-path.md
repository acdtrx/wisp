# One setup path

Phase 7 of `docs/reviews/2026-11-17/IMPLEMENTATION.md`, second feature. Findings P-1,
P-4 and P-8 of that folder's `AUDIT.md`. Built to the plan's ground rule 1: what a build
from scratch would have.

## What it is for

Two things are wrong with setup today. A fresh install can end with no network for VMs
or containers, and says nothing about it. And the installer and the updater run
different step lists, so a step added to setup reaches new installs but never the hosts
that update. This feature gives Wisp one setup: the same steps for install and update,
safe to run again, ending with Wisp usable.

## Decisions

- **One list of steps, run by install and by update.** Install is copy, setup, first
  start. Update is swap, setup, start. A step added to setup reaches every host at its
  next update.
- **Every step checks first and changes only what is missing.** A second run changes
  nothing. A step with nothing to do starts no package manager and rewrites no file.
- **A failed step fails the run and names itself.** No "completed with warnings". On
  install the installer stops there; on update the updater rolls back.
- **The network is declared through the host's own network tool** (netplan,
  NetworkManager or systemd-networkd, whichever runs the host), so it is there after a
  reboot with nothing of Wisp's involved. That covers the bridge and the `wisp-dns0`
  stub interface with its address. `wisp.service` loses its `ExecStartPre` line that
  creates the interface. No unit or command of ours finishes or repairs the network.
  (`cni-dhcp.service` stays: it is the DHCP daemon container networking uses, not a
  setup step.)
- **Supported hosts** (settled 2026-11-18): Debian and Ubuntu with systemd 254 or newer
  (Debian 13, Ubuntu 24.04 and later), with the network run by netplan, NetworkManager
  or systemd-networkd, and an uplink that can be bridged. The systemd floor is checked
  on the version itself; the unit's restart backoff needs it. Setup
  refuses any other host before it changes anything, and names what is supported. Arch
  is dropped as a host everywhere: setup, the OS-update helper, the backend's host code
  and the docs.
- **A bridge is required.** Without one no VM or container has a network. Setup uses
  the bridge that carries the host's uplink if there is one; otherwise it creates `br0`
  on the uplink interface. One rule for install and update. libvirt's default NAT
  network stays off, and the code that falls back to it goes.
- **The bridge is chosen first and applied last.** Its name is known from the start, so
  the steps that depend on it (container networking) are written for it without waiting
  for it. Applying it is setup's last change, and it keeps the host's address: the
  bridge takes over the interface's hardware address and its DHCP identity, or its
  static settings. A session that drops anyway has nothing left to lose.
- **Setup makes the bridge on a plain Ethernet uplink, on DHCP or with a static address
  set through the host's network tool** (settled 2026-11-18). The interface's whole
  address configuration moves to the bridge and leaves the interface, in the tool's own
  files, edited through the tool. Any other uplink (a bond, a VLAN, a definition that
  matches several interfaces) is refused before anything changes: the operator makes
  the bridge with the host's tool, and setup uses it.
- **A bridge setup makes is checked before and after.** The new configuration is
  validated before it goes live. Afterwards the bridge must hold the address, hardware
  address and DHCP identity the interface had; if it does not, setup puts the host's
  network back as it was and fails.
- **The installer asks everything first, then works to the end unattended**: the
  password, the server name, and one confirmation that names the interface it will
  bridge. With no terminal, the answers come from its arguments and it creates the
  bridge without asking. If the operator declines and the host has no bridge, the
  install stops before it has changed anything, and says that Wisp needs a bridge: make
  one, or let setup make it.
- **Hosts never build.** `push.sh` ships the same prebuilt tarball a release does,
  staged by one script the release workflow shares. A fresh host needs only ssh, sudo
  and `tar`. A manual upgrade is the new tree's installer; the "git checkout on the
  server" path goes.
- **With no terminal** the password is read as one line on standard input and the
  server name comes from an argument, defaulting to the host's name.

## What it changes in the docs

- `specs/DEPLOYMENT.md`: rewritten as the contract for install, setup and manual
  upgrade: what the operator runs, what is asked, what the host looks like afterwards.
  The script walkthrough goes (P-8).
- `specs/UPDATES.md`: the updater's step list; the shared-steps row becomes "setup".
- `specs/CONTAINERS.md`, only where it describes how `wisp-dns0` and the stub address
  come to exist.
- The single passages in other specs that name a script or command this feature
  removes, or describe Arch as a host: `API-HOST.md`, `CONFIGURATION.md`,
  `CONTAINERS.md`, `HOST-MONITORING.md`, `SETTINGS.md`, `STORAGE.md`, `noVNC.md`.
- `PRODUCTION.md`, Deploys. `README.md`, the install section.
- `BACKLOG.md`: "Setup strategy: one update-safe path", "A push to a fresh host needs
  `unzip` first" and "Arch: a custom pacman `DBPath` isn't followed" are removed.

## Constraints

- No step list is kept in two places. `common-steps.sh`, the seam both paths share
  today, becomes the whole of setup or goes.
- An update must not fail because another package run holds the system's package lock
  when setup has nothing to install.
- Verified in throwaway VMs from the image the test host has (Ubuntu, netplan). The
  NetworkManager and plain systemd-networkd variants are run in Ubuntu VMs adapted to
  them, and the report says they were approximated.
- The first release that carries this is installed by the previous updater. The builder
  says what that means for that one update before building.
- The reasons behind today's network setup are kept, not rediscovered: the header of
  `scripts/linux/setup/container-dns.sh` records three ways of holding the stub address
  that failed (on the bridge at run time, declared on the bridge, and in netplan beside
  DHCP), and the unit's `ExecStartPre` line is its fallback for hosts systemd-networkd
  does not manage. The builder reads that history first. If the host's own tool cannot
  hold the interface on a kind of host Wisp supports, the builder stops and says so; the
  fallback is not kept quietly.

## Milestones

### 1. Setup is one list, safe to run again, and fails loudly

Acceptance, in a throwaway VM with no Wisp on it:

- Setup runs from a fresh host that has only ssh and sudo, and ends with every step
  reported done.
- A second run reports every step as already in place, starts no package manager and
  changes no file it owns.
- With one step made to fail, the run stops there with a non-zero exit and that step's
  name.

### 2. An install ends usable

Acceptance, each in a fresh throwaway VM with no bridge, installing over ssh:

- The installer asks its questions before it changes anything, then runs to the end
  without another one.
- Accepted: the install ends with `br0` holding the address the VM had before; the ssh
  session is still alive, or reconnects to the same address. A container started
  afterwards gets an address on the LAN and its `.local` name resolves from another
  machine. The bridge is offered for new VMs.
- After a reboot of the VM, all of that still holds, and `wisp.service` has no line that
  creates an interface. The stub interface and its address are there before the backend
  starts: its first start after the reboot logs the DNS forwarder listening on the stub
  address, and a container resolves a `.local` name and an outside name through it.
- The stub address survives what removed it before: a restart of the host's network
  service, a re-apply of its network configuration, and a DHCP renewal on the bridge.
  After each, a container still resolves names, and the host keeps its own `.local`
  name (no `-2` rename).
- No terminal: the same result, with nothing asked.
- Declined: the install stops with the message; nothing on the host was changed.
- On a VM that already has a bridge on its uplink, the install uses it and creates
  none.

### 3. An update runs the same setup

Acceptance, in a throwaway VM, updating between two builds of the branch:

- With a package setup installs removed, a directory it creates deleted and a helper it
  installs deleted, an update restores all three.
- With one setup step made to fail in the new build, the update rolls back and the old
  backend is healthy.
- With the package lock held by another process and nothing to install, the update
  completes.
- On the test host itself, deploying the branch changes nothing in its network
  configuration.

### 4. The docs

The docs listed above. Acceptance: every command and prompt `DEPLOYMENT.md` and the
README name is one that was run in milestones 1 to 3.

## Not in this feature

- The helpers' dialects, shell rules, and the smaller script clean-ups (P-6, P-7): a
  later feature of this phase.
- VLAN filtering on the bridge, and the other network backlog entries.
