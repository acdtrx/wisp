# VMs started and stopped by an agent

Agreed with the user on 2026-11-27. It follows "VMs and the host from the CLI".

## What it is for

An `agent` token can look at a VM and nothing more. With this feature it starts, stops
and restarts one: from the API, an MCP tool or the CLI. It still creates, edits and
deletes none.

## The specs it changes

Written by the design session with this file, and agreed with it:

- `specs/AUTH.md`: the `agent` scope gains a VM's start, stop, restart and force stop.
- `specs/API-VMS.md`: those four routes are `agent`. The stop becomes a job that ends
  when the VM is off.
- `specs/VM-MANAGEMENT.md`, `specs/BACKUPS.md`, `specs/API.md`: the stop among the
  jobs, its 5 min bound, and how it holds the VM's lock.
- `specs/UI-VM.md`: Stop shows as a job on the page.
- `specs/MCP.md`: the tools `start_vm`, `stop_vm`, `force_stop_vm` and `restart_vm`.
- `specs/CLI.md`: the commands `vms start | stop | restart`.

The builder edits none of these, but for the row of `VM_STOP_TIMEOUT` in
`specs/ERROR-HANDLING.md`. It reports each sentence its work makes untrue, with file
and line. `README.md` is the builder's.

## Decisions

- **The four a container has.** Start, stop, restart and force stop. Pause and resume,
  and every change to what a VM is, stay `admin`.
- **A stop ends when the VM is off, and the server does the waiting.** One stop for the
  page, the API, the MCP tool and the CLI: a job that asks the guest, then waits. A
  guest that ignores the request no longer fails silently: the job fails after 5 min.
- **The wait holds no lock.** The job holds the VM's lock while its request is sent, as
  the stop does today, and waits without it: a force stop is accepted meanwhile, and
  ends the wait as done.
- **A restart stays a request.** It asks the guest and answers at once: nothing tells
  when a guest is back up.

## Verification

- The backend's unit tests for the routes' levels, the stop job's checks, its end on
  the VM going off, its bound and its sharing.
- Go unit tests, and the end-to-end test's fake Wisp, for each command's request.
- On tini (`CODING-RULES.md` §14), with one throwaway VM the builder makes with an
  `admin` token and deletes when done, its disk and its cloud image with it. The user's
  own VMs there are never started, stopped or changed.

## Milestones

### 1. An agent starts and force-stops a VM

- With an `agent` token, `POST /api/vms/:name/start`, `force-stop` and `reboot` answer
  as they do for an `admin` one; with a `read` token each answers **403**
  `SCOPE_INSUFFICIENT`.
- With an `agent` token, a VM's create, edit, delete, disk, CD-ROM, USB, cloud-init,
  pause, resume and backup routes each answer **403** `SCOPE_INSUFFICIENT`.
- On tini, `wisp vms start <name>` waits for the job and ends `0` with the VM running;
  on a running VM it prints `VM_ALREADY_RUNNING` and ends `1`.
- `wisp vms stop <name> --force` waits for the job and ends `0` with the VM off.
- `wisp vms restart <name>` says the guest was asked to restart, and ends `0` at once.
- The MCP tools `start_vm`, `force_stop_vm` and `restart_vm` do the same, and
  `tools/list` shows them to an `agent` token and not to a `read` one.

### 2. A stop that ends when the VM is off

- `POST /api/vms/:name/stop` answers **202** with a job's ack; on a VM that is not
  running, **409** `VM_NOT_RUNNING`.
- On tini, the job ends `done` when the guest has shut down, and the VM reads off.
- A second stop while the first waits answers the first job's ack.
- A force stop while a stop waits is accepted, and the stop's job ends `done`.
- A VM that is not off after the bound fails the job with `VM_STOP_TIMEOUT` and is
  left running (a unit test with a short bound; on tini, a guest that ignores the
  request).
- `wisp vms stop <name>` prints the job's progress and ends `0` when the VM is off; the
  MCP tool `stop_vm` returns the job's ack.

### 3. Stop on the page

- On the VM's page, Stop shows the job in the jobs list until the VM is off, and the
  header's state follows it.
- While a stop waits, Force stop is available and works; Start, Delete and the editors
  are disabled, the job's title the reason.
- A stop that fails at its bound shows the job's error on the page.
