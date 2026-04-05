# USB Passthrough

USB passthrough allows host USB devices to be attached to virtual machines. Devices can be hot-plugged to running VMs or configured persistently for stopped VMs.

## Host Device Discovery

Host USB devices are enumerated from Linux **sysfs** under `/sys/bus/usb/devices/` (no `lsusb` or `usbutils`). For each device directory that exposes `idVendor` and `idProduct`, the backend reads `busnum`, `devnum`, optional `manufacturer` / `product` strings, and resolves a display name in this order:

1. Sysfs `product` string (from the device descriptor), if present
2. `/usr/share/hwdata/usb.ids` or `/usr/share/misc/usb.ids` (installed with the `hwdata` package via server setup) — product line for `vendorId:productId`, else vendor name + `" Device"`
3. Sysfs `manufacturer` only
4. `"Unknown Device"`

Each device is identified by:

| Field | Description |
|-------|-------------|
| `bus` | USB bus number (e.g. "001") |
| `device` | Device number on the bus (e.g. "003") |
| `vendorId` | 4-character hex vendor ID (e.g. "046d") |
| `productId` | 4-character hex product ID (e.g. "c077") |
| `name` | Human-readable device name (e.g. "Logitech USB Mouse") |

**Live updates:** The backend watches `/dev/bus/usb` (and per-bus subdirectories) with `fs.watch`. When the device set changes, clients subscribed to `GET /api/host/usb/stream` receive a new JSON array (see [API.md](API.md)). `GET /api/host/usb` still returns a one-off snapshot (same shape).

On macOS (development), host USB listing returns an empty array.

## Device Identification

USB devices are identified by the `vendorId:productId` pair. This means:
- The same type of device (e.g. two identical USB drives) may appear as the same ID
- Identification is by device type, not by physical port

## Operations

### List attached devices

`GET /api/vms/:name/usb` returns the USB devices currently attached to a VM (parsed from the domain XML).

### Attach

`POST /api/vms/:name/usb` with `{ vendorId, productId }`:

- **Running VM:** Hot-plugs the device immediately using `Domain.AttachDevice(xml, flags)` with flags for LIVE+CONFIG. The device is both active immediately and persisted in the domain config.
- **Stopped VM:** Adds the device to the persistent domain configuration only. The device will be attached when the VM starts.

The USB device XML:

```xml
<hostdev mode='subsystem' type='usb' managed='yes'>
  <source>
    <vendor id='0x046d'/>
    <product id='0xc077'/>
  </source>
</hostdev>
```

### Detach

`DELETE /api/vms/:name/usb/:id` where `id` is `vendorId:productId`:

- **Running VM:** Hot-unplugs the device using `Domain.DetachDevice(xml, flags)` with LIVE+CONFIG flags.
- **Stopped VM:** Removes the device from the persistent configuration.

## UI Presentation

The USB section in the VM Overview panel shows:

1. **Attached devices** — a **table** of devices currently attached to the VM (name, ID, bus/device when known). Row **Detach** (icon-only, hover-reveal). Empty state points to **Attach** in the section header.
2. **Attach** — header control (`Plus`+USB) opens a **modal** listing host USB devices **not** already attached to this VM, each row with **Attach**. The modal matches the image-library modal pattern (overlay, close, escape). Choosing **Attach** on a row attaches the device and **closes** the modal.

Host device names update via **SSE** (`/api/host/usb/stream`) when devices are plugged or unplugged. VM-attached devices are refreshed after attach/detach actions. Attach and detach are immediate API actions — no Save button, no dirty state tracking.

Attach and detach operations work in both states:
- **Running VM** — hot-plug/unplug (immediate effect)
- **Stopped VM** — persistent config update (takes effect on next start)

## Validation

- `vendorId` and `productId` must match the pattern `^[0-9a-fA-F]{4}$` (exactly 4 hexadecimal characters)
- The USB `:id` parameter in the detach endpoint must contain exactly one `:` separator
