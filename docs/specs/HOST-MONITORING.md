# Host Monitoring

Wisp provides real-time monitoring of host system resources and per-VM statistics, streamed to the frontend via Server-Sent Events (SSE).

## Data update policy

**All data that updates over time in the app is pushed from the server via SSE** — no repeated GET requests (polling) for live metrics. Host stats (CPU, memory, disk I/O, net I/O, per-core usage, temperature, power, load average, pending updates), VM list, and per-VM stats each have a dedicated SSE stream. One-time or on-demand GET is used only for static or user-triggered data (e.g. `GET /api/host/hardware`, `GET /api/host` for the Software section, settings).

## Host Stats

### What is measured

Host metrics are read directly from the Linux `/proc` and `/sys` filesystems — no third-party monitoring library. Rates and percentages are deltas between consecutive reads (every 5 seconds). Temperature and power are `null` when unavailable (e.g. non-Linux, VM, or no sysfs support).

- **CPU usage %**, aggregate and per core, and the load average (1, 5, 15 min).
- **Memory usage %** is (Total - Available) / Total; buffers, cached and swap are reported too.
- **CPU temperature** is the primary CPU sensor: package/CPU sensors are preferred over generic ACPI.
- **CPU power (watts)** is Intel RAPL only, best-effort: not available on AMD or in VMs. The RAPL file is often root-only, so setup grants the deploy user read access with a udev rule that sets group read at every boot (a direct `setfacl`/`chmod` on sysfs would not survive a reboot).
- **Disk I/O** and **network I/O** in MB/s.

**Host network throughput** (settled 2026-10-16) is the host's traffic over the wire: bytes through its physical NICs — the interfaces with a sysfs `device` link (PCI/USB/virtio NICs, Wi-Fi). Virtual interfaces (bridges, bonds, VLANs, `vnet*`/tap, `veth*`, the `wisp-dns0` dummy, `lo`) are excluded: they carry bytes a physical NIC already counted. A bond's slaves are physical and counted; the bond itself is not. Traffic that never touches a wire (VM↔VM on one bridge, host↔guest) is not part of this number — per-VM and per-container stats show it.

### VM allocation totals

In addition to host-level metrics, the stats include aggregate allocation across **running VMs only**:

| Field | Source |
|-------|--------|
| Allocated vCPUs | Sum of vCPU count from each active domain |
| Allocated memory | Sum of memory allocation from each active domain |
| Running VM count | Number of active domains |
| Running container count | Number of containers in the running state (from containerd + on-disk configs, same as the workload list) |

The VM list is read from libvirt when libvirt announces a change (start, stop, define, undefine) and on the next ask after a libvirt call failed, never on a healthy tick. Each stats tick asks libvirt **one cheap question** (its version), so that a libvirtd that stopped or restarted is noticed while a tab is open: a failed answer marks the list stale, and the same tick reads it and reports the error. The question also makes libvirt-dbus subscribe to libvirt's events again after a libvirtd restart (settled 2026-11-22). A figure whose list could not be read is `null`, never a guessed 0 (below).

### SSE stream

Host statistics are pushed on the `stats` topic of `GET /api/events` (the single multiplexed always-on SSE stream, see [API.md](API.md) § Events stream) every 5 seconds. Topic `data`:

```json
{
  "cpu": {
    "allocated": 8,
    "total": 16,
    "usagePercent": 34.2,
    "perCore": [12.5, 45.0, 8.3]
  },
  "cpuTemp": 62.5,
  "cpuTempThresholds": { "maxC": 80.0, "critC": 95.0 },
  "thermalZones": [
    { "type": "x86_pkg_temp", "label": "CPU Package", "tempC": 62.5, "maxC": 80.0, "critC": 95.0, "pciAddress": null },
    { "type": "nvme nvme0", "label": "nvme nvme0", "tempC": 41.0, "maxC": null, "critC": null, "pciAddress": "0000:01:00.0" }
  ],
  "cpuPowerWatts": 45.2,
  "memory": {
    "allocatedGB": 12.0,
    "totalGB": 64.0,
    "usagePercent": 28.1,
    "usedBytes": 0,
    "buffersBytes": 0,
    "cachedBytes": 0,
    "swapTotalBytes": 0,
    "swapUsedBytes": 0
  },
  "loadAvg": [1.2, 0.8, 0.6],
  "disk": { "readMBs": 1.2, "writeMBs": 0.4 },
  "net": { "rxMBs": 2.1, "txMBs": 0.8 },
  "runningVMs": 3,
  "runningContainers": 2,
  "pendingUpdates": 0,
  "rebootRequired": false,
  "rebootReasons": []
}
```

- `runningContainers` is the number of containers reported as running (same source as the workload list). It is `null` when the container list could not be read, as `runningVMs`, `cpu.allocated` and `memory.allocatedGB` are when the VM list could not (settled 2026-11-22: a manager does its job or says it could not). The top bar shows "—" for a `null` figure.
- A per-tick sensor or counter read that fails is no value, and is logged once per path, not every tick.
- `cpuTemp` and `cpuPowerWatts` may be `null`.
- `cpuTempThresholds` contains thresholds for the selected primary CPU sensor as `{ maxC, critC }` (or `null` when unavailable).
- `thermalZones` includes all readable thermal sensors (`type`, user-facing `label`, `tempC`, `maxC`, `critC`, `pciAddress`). It can be empty when sensors are unavailable. For entries sourced from hwmon, `pciAddress` is derived from the resolved `device` symlink path by taking the **last** `dddd:dd:dd.d` segment (so NVMe and other devices nested under a PCI function still map to that function’s BDF); `null` if no PCI segment is found. Thermal zones from `/sys/class/thermal` use `pciAddress: null`.
- `pendingUpdates` is the count of upgradable packages from a background hourly check (see OS Updates); 0 if check unavailable.
- `rebootRequired` is `true` when the host needs a reboot to apply pending kernel/system updates. `rebootReasons` is a list of short tags: package names from `/var/run/reboot-required.pkgs`. Detected via `/var/run/reboot-required`.

On macOS (development) the stream has the same shape from what the OS offers: disk and network rates are always 0, `cpuTemp` and `cpuPowerWatts` are `null`, `thermalZones` is empty.

## Per-VM Stats

A running VM's stats: vCPU usage % (CPU time against wall time), disk I/O (read/write MB/s, all block devices), network I/O (rx/tx MB/s, all NICs), uptime (from when the VM started running), the guest's hostname and primary IPv4 or IPv6 address when the guest agent is enabled and answers, and the state.

The backend does not expose RAM used/allocated in the VM stats stream (memory stats would require balloon or guest agent and are not currently implemented).

### SSE stream

`GET /api/vms/:name/stats` returns an SSE stream that pushes every 5 seconds:

- **Running VM:** Full stats object with all metrics
- **Stopped VM:** Only state information, no resource metrics

**Per-tick libvirt traffic is intentionally minimal.** A VM known not to be running costs no libvirt call. A running VM costs one stats call per tick, narrowed to the CPU, vCPU, interface and block groups — not the balloon group, which forces a qemu-monitor round-trip. The guest agent is asked at most once per 30 s per VM, and only for a VM that has one. A stats call that fails (libvirt gone, or the VM stopped as the tick ran) fails the tick: the stream sends its error frame and the page shows "Figures unavailable: …", never zeros (settled 2026-11-22).

## Color Thresholds

The UI displays stat values with color coding based on utilization level:

| Threshold | Color | Meaning |
|-----------|-------|---------|
| < 60% | Green | Normal |
| 60% – 85% | Amber | Warning |
| > 85% | Red | Critical |

These thresholds apply to CPU and memory utilization. Disk and network I/O are displayed without color coding (they are throughput values, not utilization percentages).

## Host Info Endpoint

`GET /api/host` provides static host information (not real-time stats):

| Field | Description |
|-------|-------------|
| hostname | System hostname |
| nodeVersion | Node.js version |
| libvirtVersion | Libvirt version (from DBus) |
| qemuVersion | QEMU version (from libvirt) |
| wispVersion | Application version (from package.json) |
| uptimeSeconds | Host uptime |
| kernel | Kernel version |
| osRelease | Linux: `/etc/os-release`. macOS: from the system profiler when it succeeds; otherwise `null` |
| primaryAddress | Primary network interface IP — first non-internal IPv4, skipping `lo` and the link-local `169.254.0.0/16` range (which includes Wisp's own mDNS DNS forwarder at `169.254.53.53`) |

## Host Hardware Endpoint

`GET /api/host/hardware` returns static or semi-static hardware details for the Host Overview tab. All file reads, except two privileged helpers: `wisp-dmidecode` for RAM and `wisp-smartctl` for disk SMART summaries ([DEPLOYMENT.md](DEPLOYMENT.md), The helpers). No `lspci` subprocess.

| Data | Notes |
|------|-------|
| CPU model, cores, threads, MHz, cache, core types (`coreTypes.performance[]`, `coreTypes.efficiency[]`) | `coreTypes` is `null` on non-hybrid CPUs (or kernels that do not expose hybrid sysfs groups). When available, the Host Overview CPU section shows per-core usage split into **Performance cores** and **Efficiency cores**. |
| Block devices (name, model, size, `rotational`, `pciAddress`, `smart`) | The SMART summary includes health, temperature, power-on hours, NVMe wear/spare fields, and ATA sector-health / SSD-life attributes where parseable. **Reading SMART never spins up a disk** (settled 2026-10-16): a drive in STANDBY/SLEEP is skipped and reported as `overall: "sleeping"` (UI: **Sleeping**) with no error. |
| Filesystem usage per mount | From the mount table ([STORAGE.md → Mount table](STORAGE.md#mount-table)) + `statfs()`; one row per mount point (when mounts are stacked, the visible topmost one); omits `/proc`, `/sys`, `/dev`, `tmpfs`/`devtmpfs`/`squashfs`, `ip netns` bind mounts under `/run/netns` and `/var/run/netns`, and containerd's task mounts under `/run/containerd/` (a running container's root filesystem): none of these is host storage. **Network shares are left out too** (settled 2026-11-22), by `df -l`'s rule: a mount whose source contains `:` (NFS, sshfs) or starts with `//` (SMB). The list is local storage only, so the server never waits on a share that stopped answering — not in a worker thread or a child process either; a share's state is on the Mounts card, which reads the mount table and never the share. A read that fails leaves its row out and is logged once per path. Sizes follow `df`: `usedBytes` = (`blocks` − `bfree`) × `bsize`; `availBytes` = `bavail` × `bsize` — space an unprivileged writer can still use, excluding the filesystem's root reserve — so `usedBytes + availBytes` can be less than `totalBytes` |
| Network adapters (name, MAC, speed, state) | |
| RAM modules (type, size, speed, slot, form factor, manufacturer, voltage) | Empty only when DMI lists no modules (a VM, usually). A read that failed is `memory: null` with `memoryError`, the helper's error line, and Host Overview says "RAM modules could not be read: …" (settled 2026-11-22). A manufacturer a BIOS writes as a raw JEDEC ID in hex (e.g. `80CE000080CE`) is resolved to its name; unrecognised hex codes are passed through as-is. Slot values are sequential numbers (1, 2, 3, …) instead of the verbose dmidecode Locator strings |
| PCI devices (address, class, vendor/device names, driver) | Vendor/device/class strings resolved from the system's `pci.ids` database; hex fallbacks if the file is missing |
| System / board / BIOS (`system` object) | `null` for the whole object when DMI sysfs is unavailable |

On Host Overview, a PCI device's temperature comes from the stats stream's `thermalZones`, matched by `pciAddress`; an NVMe drive's the same way; the motherboard's from the first ACPI `acpitz` zone when present.

On macOS (development) the same shape is filled from the system profiler, and from OS-only data when the profiler fails.

## Host Discovery Endpoints

| Endpoint | Returns |
|----------|---------|
| `GET /api/host/bridges` | Network bridge interface names |
| `GET /api/host/firmware` | Available UEFI firmware file paths |
| `GET /api/host/usb` | USB devices connected to the host (snapshot) |
| `GET /api/host/usb/stream` | SSE — same device array as it changes (hotplug) |

## Host Power Endpoints

When `wisp-power` is available (`/usr/local/bin/wisp-power` and its sudoers rule, both installed by setup):

| Endpoint | Action |
|----------|--------|
| `POST /api/host/power/shutdown` | Runs `wisp-power shutdown` (host shuts down) |
| `POST /api/host/power/restart` | Runs `wisp-power reboot` (host reboots) |

Returns 503 `POWER_UNAVAILABLE` if the script is not configured.

## OS Updates

When `/usr/local/bin/wisp-os-update` is installed:

| Endpoint | Action |
|----------|--------|
| `POST /api/host/updates/check` | A job ([API.md → Job routes](API.md#job-routes)) whose result is `{ count }` of upgradable packages, and the one route that starts the check (settled 2026-11-20). Internally runs the `list` op. A shared job: a start while one runs, from any trigger (this route, the hourly check), joins it, so concurrent calls coalesce. Updates the cached count, package list, and `updatesLastChecked` timestamp. |
| `GET /api/host/updates/packages` | Returns `{ packages: [{ name, from, to }], downloadBytes, checkedAt }` from the in-memory cache (instant): what the last check (or upgrade) left, `checkedAt` its time, `{ packages: [], downloadBytes: 0, checkedAt: null }` before any. It starts no job. Used by the Software tab "View packages" details modal; its refresh runs the check (`POST /api/host/updates/check`) and reads the list again once that job is done. |
| `POST /api/host/updates/upgrade` | A job that runs `wisp-os-update upgrade`, its output lines as progress, with result `{ ok: true }` on success; resets cached count and package list. |

The `upgrade` action runs `apt-get dist-upgrade -y` (not plain `upgrade`) so kept-back packages that require installing or removing dependencies — kernel-meta ABI jumps, transitional packages — are applied too. The `check`/`list` actions simulate with `apt-get -s dist-upgrade` so the count and package list match exactly what the Upgrade button will do.

**Non-interactive, local config kept (settled 2026-10-16).** The upgrade runs with no terminal, so nothing in the package-manager chain may prompt. The backend closes the helper's stdin, and the helper (not the caller: sudo's `env_reset` drops the environment) sets `DEBIAN_FRONTEND=noninteractive` and `NEEDRESTART_MODE=a` (Ubuntu's needrestart restarts affected services itself instead of asking). Automatic restarts are the user's explicit choice: an upgrade that touches a library or Node itself can restart `wisp.service` once dpkg has finished, so the upgrade job may end in an error (its stream lost) while the backend comes back on the new packages. Config files: a locally modified file is **kept** and the package's new version is left beside it — dpkg conffiles via `--force-confdef --force-confold` (new file as `.dpkg-dist`) and ucf-managed files such as `sshd_config` via `UCF_FORCE_CONFFOLD=1`. Unmodified config files take the new version. Not the maintainer's version (`--force-confnew`): an unattended button press must not silently replace a host's tuned config.

**Timeouts (settled 2026-11-13, CODING-RULES §6).** On inactivity, no total bound, except where noted. `list`: the helper stops an index refresh after **60 s** without output, and bounds the simulated upgrade at a fixed **60 s**, so a step that hangs is killed rather than orphaned holding the lock; the backend stops the helper after **90 s** without its output, which each step's bound ends inside. `upgrade`: stopped after **15 min** without output from apt. A stopped run fails, saying it printed nothing for that long. The check (one shared run) and the upgrade run as server jobs; each upgrade output line is the job's progress.

### Concurrency and lock contention

apt/dpkg serialize their work via lock files, so only one package-manager op can succeed at a time:

- **One check at a time.** A second concurrent check joins the one that runs. `upgrade` is exclusive — any concurrent op returns `409` with code `UPDATE_BUSY`.
- **External lock detection.** When apt/dpkg is held by another process on the host (e.g. `unattended-upgrades`), `wisp-os-update` exits `75` (EX_TEMPFAIL). The backend translates that to code `UPDATE_BUSY` with HTTP `409`. The UI renders this as a soft "another package manager operation is running" status rather than a red error, prompting the user to retry.

### Caching

The count and the package list of the last check are kept in memory only: a backend restart loses them, and the next hourly check (about 30 s after the backend's start) fills them again. A successful `upgrade` empties them (its time becomes `checkedAt`).

### Stats SSE fields

| Field | Meaning |
|-------|---------|
| `pendingUpdates` | Cached upgradable-package count |
| `updatesLastChecked` | ISO timestamp of the last successful list/check (or `null`) |
| `updateOperationInProgress` | `true` while a `check`/`list`/`upgrade` subprocess is running — the UI uses this to disable buttons and avoid surprise BUSY errors |

### Error codes

`UPDATE_BUSY` (409) and `UPDATE_CHECK_UNAVAILABLE` (503: the helper is missing, failed, or went silent past its bound): [ERROR-HANDLING.md](ERROR-HANDLING.md#codes).

`wisp-os-update` uses apt (Wisp hosts run Debian or Ubuntu).

A **background hourly check** runs automatically (first check after 30s delay), armed only where the platform can check (not on the macOS dev stub). It starts the same shared `os-update-check` job as the route, through the job starter: it is in the tray and in `GET /api/jobs`. If a check is already running when the timer fires, the tick joins it; while an upgrade runs, the tick is refused (`UPDATE_BUSY`, logged) — the running op's result populates the same caches.
