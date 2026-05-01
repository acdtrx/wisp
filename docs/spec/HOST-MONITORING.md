# Host Monitoring

Wisp provides real-time monitoring of host system resources and per-VM statistics, streamed to the frontend via Server-Sent Events (SSE).

## Data update policy

**All data that updates over time in the app is pushed from the server via SSE** — no repeated GET requests (polling) for live metrics. Host stats (CPU, memory, disk I/O, net I/O, per-core usage, temperature, power, load average, pending updates), VM list, and per-VM stats each have a dedicated SSE stream. One-time or on-demand GET is used only for static or user-triggered data (e.g. `GET /api/host/hardware`, `GET /api/host` for the Software section, settings).

## Host Stats

### Data sources

Host metrics are read directly from the Linux `/proc` and `/sys` filesystems — no third-party monitoring library:

| Metric | Source | Calculation |
|--------|--------|-------------|
| CPU usage % (aggregate) | `/proc/stat` (cpu line) | Delta of user+nice+system+irq+softirq vs total since last read |
| CPU usage % (per-core) | `/proc/stat` (cpu0, cpu1, ...) | Same delta logic per core |
| Load average | `/proc/loadavg` | 1, 5, 15 min values |
| Memory usage % | `/proc/meminfo` | (Total - Available) / Total; also Buffers, Cached, SwapTotal, SwapFree |
| CPU temperature | `/sys/class/thermal/thermal_zone*` and `/sys/class/hwmon/.../temp*_input` | Enumerates thermal sensors, converts millidegree to Celsius, prefers `thermal_zone` when both sources expose the same sensor type, and selects primary CPU temp by sensor-type priority (prefers package/CPU sensors over generic ACPI) |
| CPU power (watts) | `/sys/class/powercap/intel-rapl:0/energy_uj` | Delta of energy_uj over time; Intel RAPL only, best-effort. Not available on AMD or in VMs. |
| Disk I/O | `/proc/diskstats` | Delta of read/write sectors, converted to MB/s |
| Network I/O | `/proc/net/dev` | Delta of rx/tx bytes across interfaces (excl. lo), converted to MB/s |

Deltas are computed between consecutive reads (every 5 seconds). Temperature and power are `null` when unavailable (e.g. non-Linux, VM, or no sysfs support).

**Checking CPU power support on the server:** Run `test -r /sys/class/powercap/intel-rapl/intel-rapl:0/energy_uj && echo supported`. The file is often root-only (mode 400). `setup-server.sh` (run during install) grants the deploy user read access: it tries `setfacl` first; if sysfs is mounted with `noacl`, it creates group `wisp-power`, adds the deploy user, and installs a udev rule that sets group read on the RAPL file. After the udev fallback, log out and back in (or `newgrp wisp-power`) so the group takes effect. Not available in VMs or on non-Intel CPUs.

### VM allocation totals

In addition to host-level metrics, the stats include aggregate allocation across **running VMs only**:

| Field | Source |
|-------|--------|
| Allocated vCPUs | Sum of vCPU count from each active domain |
| Allocated memory | Sum of memory allocation from each active domain |
| Running VM count | Number of active domains |
| Running container count | Number of containers in the running state (from containerd + on-disk configs, same as the workload list) |

VM allocation fields are summed from the event-driven `vmListCache` in `vmManagerList.js` — every stats tick reads from in-memory state with **zero libvirt traffic**. The cache itself only refreshes when libvirt fires a `DomainEvent` (start, stop, define, undefine), so allocations cost nothing per tick yet stay accurate as VMs change. The running container count is computed each tick via `getRunningContainerCount()` (see container manager list).

### SSE stream

`GET /api/stats` returns an SSE stream that pushes every 5 seconds:

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

- `runningContainers` is the number of containers reported as running (same source as the workload list; 0 when unavailable).
- `cpuTemp` and `cpuPowerWatts` may be `null`.
- `cpuTempThresholds` contains thresholds for the selected primary CPU sensor as `{ maxC, critC }` (or `null` when unavailable).
- `thermalZones` includes all readable thermal sensors (`type`, user-facing `label`, `tempC`, `maxC`, `critC`, `pciAddress`). It can be empty when sensors are unavailable. For entries sourced from hwmon, `pciAddress` is derived from the resolved `device` symlink path by taking the **last** `dddd:dd:dd.d` segment (so NVMe and other devices nested under a PCI function still map to that function’s BDF); `null` if no PCI segment is found. Thermal zones from `/sys/class/thermal` use `pciAddress: null`.
- `pendingUpdates` is the count of upgradable packages from a background hourly check (see OS Updates); 0 if check unavailable.
- `rebootRequired` is `true` when the host needs a reboot to apply pending kernel/system updates. `rebootReasons` is a list of short tags (Debian/Ubuntu: package names from `/var/run/reboot-required.pkgs`; Arch: `kernel <running> → <installed>`). Detected via `/var/run/reboot-required` on Debian/Ubuntu and by comparing `uname -r` to the newest kernel in `/usr/lib/modules/` on Arch; always `false`/empty on other distros.

The stream runs until the client disconnects. The interval timer is cleaned up on connection close.

### macOS (development, Tier A)

When the backend runs on macOS (local dev; no libvirt), host stats avoid `/proc` / `/sys` (`backend/src/lib/darwin/host/procStats.js`):

| Metric | Source | Notes |
|--------|--------|--------|
| CPU (aggregate + per-core) | `os.cpus()` `times` | Delta between SSE ticks (~3 s), same idea as `/proc/stat` |
| Load average | `os.loadavg()` | 1, 5, 15 min |
| Memory | `os.totalmem()` + **`/usr/bin/vm_stat`** | **Not** `os.freemem()` alone — on Darwin that value is only the small free page pool, so “used” looked ~100%. **Available**-like bytes = `(free + inactive + speculative + purgeable pages) × page size` from `vm_stat`; **used** = total − that (clamped). **`cachedBytes`** ≈ inactive × page size (file cache analogue). **`sysctl -n vm.swapusage`** for swap total/used when available. If `vm_stat` fails, falls back to `total − os.freemem()`. |
| Disk / net throughput | — | Always 0 (no Tier A source without extra counters) |
| Thermal / power | — | `cpuTemp` null, `thermalZones` empty, `cpuPowerWatts` null |

`GET /api/host/hardware` on macOS (`backend/src/lib/darwin/host/hostHardware.js` and `systemProfilerHardware.js`) runs **`/usr/sbin/system_profiler -json`** (types include `SPHardwareDataType`, `SPMemoryDataType`, `SPStorageDataType`, `SPNVMeDataType`, `SPPCIDataType`, `SPNetworkDataType`, `SPDisplaysDataType`), parses JSON with `JSON.parse`, and maps fields into the same response shape as Linux. **CPU** uses hardware overview (`chip_type` / `cpu_type`, `number_processors` for Apple Silicon P/E split when the string matches `proc total:perf:eff:…`). **Memory** modules, **disks** (storage + NVMe trees), **PCI**-like rows, **display/GPU** (from displays data), and **system** (model, ROM, Apple identifiers) come from the profiler when present. **Filesystem usage** (used vs total bytes) still uses **`fs.statfsSync`** on `/` and `/System/Volumes/Data` — those values change over time and are not taken from the profiler. **Network** starts from `os.networkInterfaces()` and is enriched with MAC and link speed from `SPNetworkDataType` when the `interface` name matches. If `system_profiler` fails (timeout, parse error), the handler falls back to **OS-only** data (`os.cpus()`, empty disks/PCI/memory). Profiler PCI **addresses** are synthetic (`0000:fe:…`) for UI sorting, not real BDFs. Host stats SSE still has **no** disk/net throughput rates on macOS.

`GET /api/host` on macOS merges **`SPSoftwareDataType`** (`os_version`, `kernel_version`, `local_host_name`) into `osRelease`, `kernel`, and `hostname` when `system_profiler` succeeds (see `systemProfilerSoftware.js`).

## Per-VM Stats

### Data sources

Per-VM metrics are read via libvirt DBus:

| Metric | Source | Notes |
|--------|--------|-------|
| vCPU usage % | Domain GetStats (cpu.time delta) | Computed as delta of CPU time vs wall time |
| Disk I/O (read/write MB/s) | Block stats per device | Aggregated across all block devices |
| Network I/O (rx/tx MB/s) | Interface stats per NIC | Aggregated across all NICs |
| Uptime | Tracked from domain start event | Measured from when the VM started running |
| Guest hostname | Guest agent GetHostname | Shown when guest agent is enabled and available |
| Guest IP | Guest agent InterfaceAddresses | Primary IPv4 or IPv6, when guest agent is available |
| State | Domain state query | Running, stopped, paused, etc. |

The backend does not expose RAM used/allocated in the VM stats stream (memory stats would require balloon or guest agent and are not currently implemented).

### SSE stream

`GET /api/vms/:name/stats` returns an SSE stream that pushes every 5 seconds:

- **Running VM:** Full stats object with all metrics
- **Stopped VM:** Only state information, no resource metrics

The frontend subscribes when a VM is selected and unsubscribes when deselected (or a different VM is selected).

Per-tick libvirt traffic is intentionally minimal:

- **Non-running VM (cached):** zero DBus calls. `getVMStats` fast-paths on `getCachedStateCode(name)`; the cache is refreshed on every libvirt `DomainEvent`, so the cost stays at zero until the VM is actually running again.
- **Running VM:** one `GetStats(VM_STATS_MASK, 0)` per tick — and that's it on most ticks. The bitmask narrows the call to the four groups we actually consume (`CPU_TOTAL | VCPU | INTERFACE | BLOCK`), excluding `BALLOON` (which forces a qemu-monitor round-trip on libvirtd). Only when the cached `guestAgent` flag is true *and* the per-VM 30 s `guestInfoCache` entry has expired: one `InterfaceAddresses` + `GetHostname` pair to the in-guest agent (so ~1 in 6 ticks). **No `DomainLookupByName`, no `GetState`, no `Introspect`, no `GetXMLDesc`.**

How the per-tick cost was driven down:

- `DomainLookupByName` is skipped via `getCachedDomainPath(name)` — paths are captured by `ListDomains` during cache population and are stable for the lifetime of the domain definition.
- `GetState` is skipped — `getCachedStateCode(name)` is kept current by `DomainEvent` signals; the rare race (state changes between event and tick) is handled by the existing `try/catch` around `GetStats`.
- `Introspect` is skipped — `getDomainObjAndIface` reads from `connectionState.domainProxyCache`, populated once per domain path and invalidated on disconnect / undefine.
- `GetXMLDesc` is skipped — vCPU count, guest-agent presence, and `localDns` come from the `vmListCache` via `getCachedVcpus`/`getCachedGuestAgent`/`getCachedLocalDns`.
- Guest-agent calls (`InterfaceAddresses`, `GetHostname`) are gated by `guestInfoCache` (TTL 30 s, dropped when state turns non-running) — these are the heaviest because libvirtd has to round-trip through virtio-serial to qemu-ga inside the guest, and the data they return (hostname, primary IP) is essentially static between DHCP renewals.

## Color Thresholds

The UI displays stat values with color coding based on utilization level:

| Threshold | Color | Meaning |
|-----------|-------|---------|
| < 60% | Green (`#16a34a`) | Normal |
| 60% – 85% | Amber (`#d97706`) | Warning |
| > 85% | Red (`#dc2626`) | Critical |

These thresholds apply to CPU and memory utilization. Disk and network I/O are displayed without color coding (they are throughput values, not utilization percentages).

## UI Presentation

### Host stats bar

Embedded in the top bar, always visible. Compact inline pills:

```
[ CPU  8/16 cores  ████░░ 34% ]  [ RAM  12/64 GB  ███░░ 28% ]  [ Disk  ↑1.2  ↓0.4 MB/s ]  [ Net  ↑0.8  ↓2.1 MB/s ]  [ RUNNING  3 | 2 ]
```

Each pill shows: label, value, and a slim progress bar where applicable (CPU, RAM). The **RUNNING** pill shows running VM and container counts separated by `|`, each count prefixed by the monitor icon (VMs) and box icon (containers), matching the left panel workload icons.

### VM stats bar

Fixed at the bottom of the center panel. Visible whenever a VM is selected, on both Overview and Console tabs.

When the VM is **running**, pills show: vCPU (usage percent with bar), Disk (read/write MB/s), Net (tx/rx MB/s), Uptime (formatted duration). When the guest agent is enabled and available, optional pills for guest hostname ("Host") and guest IP ("IP") are shown. There is no RAM pill in the VM stats bar.

Example: `[ vCPU  ██░░ 18% ]  [ Disk  ↑0.2  ↓1.4 MB/s ]  [ Net  ↑0.1  ↓0.8 MB/s ]  [ Uptime  4h 23m ]  [ Host  myvm ]  [ IP  192.168.1.10 ]`

When the VM is **stopped**: shows a single muted label "Stopped" with no metrics. When **paused**: shows "Paused".

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
| osRelease | Linux: `/etc/os-release`. macOS: `system_profiler -json SPSoftwareDataType` (`os_overview.os_version` → `prettyName` with the **last** trailing ` (…)` removed — usually the build id; `id` `macos`, semver-ish `versionId` from the raw string) when profiler succeeds; otherwise `null` |
| primaryAddress | Primary network interface IP |

## Host Hardware Endpoint

`GET /api/host/hardware` returns static or semi-static hardware details for the Host Overview tab. On **Linux** servers, sources are as below. On **macOS** (local dev), inventory comes from **`system_profiler -json`** plus `statfs` and `os.networkInterfaces` — see *macOS (development, Tier A)* under Host Stats.

| Data | Source |
|------|--------|
| CPU model, cores, threads, MHz, cache, core types (`coreTypes.performance[]`, `coreTypes.efficiency[]`) | `/proc/cpuinfo` + `/sys/devices/cpu_core/cpus` + `/sys/devices/cpu_atom/cpus` (hybrid-only) |
| Block devices (name, model, size, `rotational`, `pciAddress`, `smart`) | `/sys/block/*` (model, size); `/sys/block/<name>/queue/rotational`; PCI BDF parsed from the block device sysfs symlink path; SMART summary from `wisp-smartctl` (`smartctl --json -a`) — includes health, temperature, power-on hours, NVMe wear/spare fields, and ATA sector-health / SSD-life attributes where parseable |
| Filesystem usage per mount | `/proc/mounts` + `statfs()`; omits `ip netns` bind mounts under `/run/netns` and `/var/run/netns` (not host storage) |
| Network adapters (name, MAC, speed, state) | `/sys/class/net/*` |
| RAM modules (type, size, speed, slot, form factor, manufacturer, voltage) | `wisp-dmidecode` (`dmidecode --type 17`); installed to `/usr/local/bin` + sudoers by `setup-server.sh`, or bundled path in dev; empty if unavailable or no DMI. When a BIOS writes the raw JEDEC manufacturer ID as hex (e.g. `80CE000080CE`) instead of a human-readable name, the backend resolves it via a built-in JEDEC lookup table in `hostHardware.js`; unrecognised hex codes are passed through as-is. Slot values are replaced with sequential numbers (1, 2, 3, …) instead of the verbose dmidecode Locator strings |
| PCI devices (address, class, vendor/device names, driver) | `/sys/bus/pci/devices/*` + system `pci.ids` (or `.gz`) under `/usr/share/misc`, `/usr/share/hwdata`, etc.; vendor/device/class strings resolved from the database; hex fallbacks if the file is missing |
| System / board / BIOS (`system` object) | `/sys/class/dmi/id/*` (board, product, BIOS); `null` for the whole object when DMI sysfs is unavailable |

All file reads except two privileged helpers: `wisp-dmidecode` for RAM and `wisp-smartctl` for disk SMART summaries (same `sudo -n` pattern as `wisp-os-update`). PCI name resolution reads `pci.ids` from `/usr/share/hwdata/` or other standard paths (see `pciIds.js`); no `lspci` subprocess. `scripts/linux/setup/packages.sh` installs `hwdata` and `smartmontools` for these host inventory features.

`coreTypes` is `null` on non-hybrid CPUs (or kernels that do not expose hybrid sysfs groups). When available, the Host Overview CPU section shows per-core usage split into **Performance cores** and **Efficiency cores** (stacked sections).

The Host Overview **Hardware** section shows a summary line (DMI board/system/BIOS when available, plus **Motherboard:** °C from the first ACPI `acpitz` thermal zone in the stats SSE `thermalZones` when present). It lists RAM modules, block devices, and PCI devices (excluding PCI bridge class `0x06`) in a single table with three labelled sections (**Main**, **I/O**, **Misc**) with a shared column layout; block devices that resolve to a PCI address are grouped under their matching PCI function row (controller first, then drives as nested rows). **Temp** for PCI rows comes from matching `pciAddress` on hwmon zones; NVMe drive temperatures use the same NVMe thermal matching as the stats stream.

## Host Discovery Endpoints

| Endpoint | Returns |
|----------|---------|
| `GET /api/host/bridges` | Network bridge interface names |
| `GET /api/host/firmware` | Available UEFI firmware file paths |
| `GET /api/host/usb` | USB devices connected to the host (snapshot) |
| `GET /api/host/usb/stream` | SSE — same device array as it changes (hotplug) |

## Host Power Endpoints

When `wisp-power` is available (`/usr/local/bin/wisp-power` after `setup-server.sh`, bundled path, or `WISP_POWER_SCRIPT`) and sudoers allow `sudo -n`:

| Endpoint | Action |
|----------|--------|
| `POST /api/host/power/shutdown` | Runs `wisp-power shutdown` (host shuts down) |
| `POST /api/host/power/restart` | Runs `wisp-power reboot` (host reboots) |

Same sudo pattern as wisp-os-update. Returns 503 if the script is not configured.

## OS Updates

When `/usr/local/bin/wisp-os-update` is installed:

| Endpoint | Action |
|----------|--------|
| `POST /api/host/updates/check` | Runs `wisp-os-update check`, returns `{ count }` of upgradable packages; also updates cached count used in SSE `pendingUpdates` and sets `updatesLastChecked` timestamp |
| `GET /api/host/updates/packages` | Runs `wisp-os-update list`, returns `{ packages: [{ name, from, to }], downloadBytes }`. Used by the Software tab "View packages" details modal. Refreshes the cached count and `updatesLastChecked` timestamp as a side-effect. On Arch `downloadBytes` is `0` (size cannot be computed non-interactively). |
| `POST /api/host/updates/upgrade` | Runs `wisp-os-update upgrade`, returns `{ ok: true }` on success; resets cached count to 0 |

`wisp-os-update` supports Debian/Ubuntu (apt) and Arch Linux (pacman); distro is detected at runtime. The script is invoked via `sudo`. Returns 503 if the script is not configured or the distro is unrecognised.

A **background hourly check** runs automatically (first check after 30s delay). The result is stored and exposed as `pendingUpdates` in the stats SSE stream so the UI can show a badge when updates are available. The timestamp of the last successful check is exposed as `updatesLastChecked` (ISO string or `null`).
