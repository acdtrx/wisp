# VMs and the host from the CLI

Agreed with the user on 2026-11-27. It follows "Containers from the CLI".

## What it is for

The CLI knows containers only. With this feature it reads the rest: the map of the
whole host, a VM with its address, the host's live figures and its hardware. An agent
with a shell then learns everything about a Wisp from the CLI alone.

## The specs it changes

Written by the design session with this file, and agreed with it:

- `specs/CLI.md`: the commands `overview`, `vms list | show`, `host stats | hardware`,
  `containers usage` and `images check`; the principle that a command answers a whole
  question and the server does the joining; VMs and the host are read, never changed.
- `specs/API-HOST.md`: two routes, `GET /api/overview` and `GET /api/host/stats`. Both
  answers exist on the server already, reached only through an MCP tool so far.
- `specs/API-VMS.md`: `GET /api/vms/:name` gains `startedAt` and `guestNetwork`.
- `specs/MCP.md`: `get_deployment_overview`, `get_vm` and `get_host_stats` point at
  those routes for their bodies.

The builder edits none of these. It reports each sentence its work makes untrue, with
file and line. `README.md` is the builder's.

## Decisions

- **Read only.** No command of this feature changes a VM or the host.
- **The server joins, the CLI prints.** A VM's address comes with the VM's read, and
  the host's figures have a plain read: the CLI picks no frame out of a stream and
  builds nothing from two answers.
- **One answer, three readers.** Each of the three reads is one function on the server:
  the route and the MCP tool both return it, and the CLI prints the route's.
- **The guest's name and address on the VM read are the ones the VM's stats stream
  holds**, kept for up to 30 s, so opening a VM's page asks the guest no more often
  than today.

## Verification

- Go unit tests, and the end-to-end test's fake Wisp, for each command's request and
  what it prints.
- The routes: the backend's unit tests for their level and their body.
- On tini (`CODING-RULES.md` §14), reads only: a `read` token, and the user's own VMs
  and containers there are read, never changed. `images check` runs once with an
  `agent` token: it is the check Wisp runs every hour by itself. The tokens are revoked
  when the builder is done.

## Milestones

### 1. The overview

- `GET /api/overview` with a `read` token answers the body `specs/API-HOST.md` gives;
  with no token it answers **401**; the MCP tool `get_deployment_overview` answers the
  same body.
- On tini, `wisp overview` prints Wisp's version, the host, its bridges, the
  certificate's domain or that there is none, then the containers and the VMs, each
  with its state and address.
- A container that is not running shows its last address marked as old, never as its
  address.
- `wisp overview --json` prints the route's body, unchanged.
- `wisp help` names `overview` as where to start.

### 2. VMs

- On tini, `GET /api/vms/:name` of a running VM with the guest agent carries
  `startedAt` and `guestNetwork` with the guest's address and name; of a VM that is off,
  or has no agent, both of `guestNetwork`'s fields are `null` and the read answers as
  fast as before. The MCP tool `get_vm` answers the same body.
- `wisp vms list` prints each VM with its state, vCPUs, memory and profile, and marks
  one that waits for a restart.
- `wisp vms show <name>` prints the VM's state, how long it has been up, the guest's
  name and address, and its settings: CPU, memory, firmware, boot order, autostart,
  each disk with its size and each network card with its bridge and MAC.
- An unknown VM prints `VM_NOT_FOUND` and ends `1`.
- A Wisp with no VM prints that there is none and ends `0`.
- `--json` on both prints the API's body, unchanged.

### 3. The host

- `GET /api/host/stats` with a `read` token answers one sample, the `stats` topic's
  payload; the MCP tool `get_host_stats` answers the same body.
- On tini, `wisp host stats` prints the host's figures and ends.
- On tini, `wisp host hardware` prints the CPU, the board, the memory modules, the
  disks with their health, the PCI devices and the GPUs.
- A part the host has none of reads as none, never as a blank line or a zero.
- `--json` on both prints the API's body, unchanged.

### 4. Mount sizes and the image check

- `wisp containers usage <name>` prints each mount with its kind and its size on disk;
  a memory folder reads as holding nothing on disk, and a partial size as "at least".
- `wisp images check` waits for the job and prints what it found; `--no-wait` prints
  the job's id; with a `read` token it prints `SCOPE_INSUFFICIENT` and ends `1`.
- `wisp help` lists every new command with a line, and `wisp help <command>` prints
  each in full with an example.
- `README.md`'s line on the CLI names VMs and the host.
