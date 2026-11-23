# USB Passthrough

USB passthrough allows host USB devices to be attached to virtual machines. Devices can be hot-plugged to running VMs or configured persistently for stopped VMs. Routes: [API-VMS.md](API-VMS.md), USB, and [API-HOST.md](API-HOST.md) for the host's device list and its stream.

## Host Device Discovery

Host USB devices are enumerated from Linux **sysfs** under `/sys/bus/usb/devices/` (no `lsusb` or `usbutils`). Each device is identified by:

| Field | Description |
|-------|-------------|
| `bus` | USB bus number (e.g. "001") |
| `device` | Device number on the bus (e.g. "003") |
| `vendorId` | 4-character hex vendor ID (e.g. "046d") |
| `productId` | 4-character hex product ID (e.g. "c077") |
| `name` | Human-readable device name (e.g. "Logitech USB Mouse") |

The name is the device's own product string; else the `usb.ids` line for `vendorId:productId` (the `hwdata` package), or the vendor's name + `" Device"`; else the device's manufacturer string; else `"Unknown Device"`.

When the device set changes, clients subscribed to `GET /api/host/usb/stream` receive the new list. On macOS (development), the list is empty.

## Device Identification

USB devices are identified by the `vendorId:productId` pair. This means:
- The same type of device (e.g. two identical USB drives) may appear as the same ID
- Identification is by device type, not by physical port

## Attach and detach

Both work at any time and act at once: no Save.

- **Running VM:** the device is hot-plugged or hot-unplugged, and the change is also written to the VM's saved definition.
- **Stopped VM:** the device is added to or removed from the saved definition only; an added device is attached when the VM starts.

**A device unplugged from the host while attached is not detached automatically**: the operator decides. Detach still works on a missing device and clears it from the VM's definition.

## Validation

- `vendorId` and `productId` must match the pattern `^[0-9a-fA-F]{4}$` (exactly 4 hexadecimal characters)
- The USB `:id` parameter in the detach endpoint must contain exactly one `:` separator
