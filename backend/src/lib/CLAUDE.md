# Backend Ops Rules (storage, cloudInit, paths)

- **paths.js:** Export `getVMBasePath(name)` — base directory for a VM under `vmsPath` (from `config/wisp-config.json`). All VM-specific files (disk, cloud-init ISO, NVRAM, cloud-init config) live under this path. Image library is `imagePath` from config (shared templates/ISOs).
- **Disk copy + resize (storage/diskOps.js, exposed via `storage/index.js`):** `qemu-img convert -O qcow2 <src> <dst>` then `qemu-img resize <dst> <size>G` if needed. Destination is the per-VM directory. Progress via child process stdout with `-p` flag; stream to client via SSE. Source file never modified or moved.
- **Cloud-init (cloudInit.js):** Password hashed via `openssl passwd -6` (child process). ISO via `cloud-localds` if available, else `genisoimage -V cidata -r -J`. Store cloud-init ISO and config under per-VM directory (getVMBasePath). GitHub key fetch is server-side only; frontend never calls github.com.

# vmManager Rules

These rules apply to `vmManager.js`, `vmManagerShared.js`, and files under `linux/vmManager/` and `darwin/vmManager/`.

- **Only DBus/libvirt caller:** No route or other module imports `dbus-next` for libvirt or calls libvirt except through `vmManager`. Linux libvirt logic lives under `linux/vmManager/`; the `vmManager.js` facade re-exports the platform implementation. (Avahi uses `dbus-next` in `lib/mdns/linux/avahi.js` only.)
- **Domain object paths:** `/org/libvirt/domains/<uuid>`. UUIDs from ListDomains. Use `getDomainObjAndIface(path)` — it caches the proxy in `connectionState.domainProxyCache` and skips the per-call DBus Introspect. Cache is cleared on bus disconnect and on `VIR_DOMAIN_EVENT_UNDEFINED`. Do not stash proxy references elsewhere; do not cache across reconnects.
- **VNC port:** Call `org.libvirt.Domain.GetXMLDesc(0)`, parse `<graphics type='vnc' port='...'>` from the XML. Expose via a function used by the console route; the route bridges TCP (`node:net` createConnection) to WebSocket. No third-party TCP proxy.
- **UEFI firmware:** Scan known firmware paths at startup; expose via GET /api/host/firmware. Paths vary by distro (e.g. Ubuntu /usr/share/OVMF, Fedora /usr/share/edk2/ovmf).
- **Dual CDROM:** Every VM XML defines sdc and sdd at creation, even if empty. Empty CDROM: no `<source>`. Attach/eject via `org.libvirt.Domain.UpdateDevice(xmlString, flags)` with `flags = 3` (LIVE + CONFIG).
- **CPU topology:** Always full topology in domain XML. Never `<vcpu>N</vcpu>` alone. Emit `<vcpu placement='static'>N</vcpu>` and `<cpu mode='host-passthrough' check='none' migratable='on'><topology sockets='1' dies='1' cores='N' threads='1'/></cpu>`. Same at VM creation and in updateVMConfig.
- **Live vs offline:** updateVMConfig uses UpdateDevice(xml, flags) or DomainDefineXML. Use `flags = 3` for hot-applicable changes, `flags = 2` for config-only. Return `{ requiresRestart: true }` for firmware, machine type, CPU count changes.
