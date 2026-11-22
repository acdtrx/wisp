/**
 * The device elements of a domain definition, in fast-xml-parser's object form:
 * built once here and used by create and by every edit, so a device reads the
 * same however it was added.
 */

/** A block disk in `slot` on `bus`, its image at `path` opened as `format`. */
export function blockDiskElement({ slot, bus, path, format }) {
  return {
    '@_type': 'file',
    '@_device': 'disk',
    driver: { '@_name': 'qemu', '@_type': format },
    source: { '@_file': path },
    target: { '@_dev': slot, '@_bus': bus },
  };
}

/** A read-only SATA CD-ROM in `slot`, with the ISO at `path` inserted or empty. */
export function cdromElement({ slot, path = null }) {
  return {
    '@_type': 'file',
    '@_device': 'cdrom',
    driver: { '@_name': 'qemu', '@_type': 'raw' },
    ...(path ? { source: { '@_file': path } } : {}),
    target: { '@_dev': slot, '@_bus': 'sata' },
    readonly: {},
  };
}

/** The virtio-scsi controller a disk on the scsi bus needs. */
export function scsiControllerElement() {
  return { '@_type': 'scsi', '@_model': 'virtio-scsi', '@_index': '0' };
}

/** Add the virtio-scsi controller to the domain's devices unless it has one. */
export function ensureScsiController(dom) {
  const controllers = dom.devices.controller;
  const list = Array.isArray(controllers) ? controllers : controllers ? [controllers] : [];
  if (list.some((c) => c['@_type'] === 'scsi')) return;
  dom.devices.controller = [...list, scsiControllerElement()];
}

/** A network adapter: a `bridge` or libvirt `network` source; the MAC and model only when given. */
export function nicElement({ type = 'bridge', source = null, mac = null, model = null }) {
  const iface = { '@_type': type };
  if (mac) iface.mac = { '@_address': mac };
  if (source) iface.source = type === 'bridge' ? { '@_bridge': source } : { '@_network': source };
  if (model) iface.model = { '@_type': model };
  return iface;
}

/** The console (VNC or SPICE), listening on the host's loopback only. */
export function graphicsElement(type) {
  return { '@_type': type, '@_port': '-1', '@_autoport': 'yes', '@_listen': '127.0.0.1' };
}

export function videoElement(model) {
  return { model: { '@_type': model } };
}

/** The memory balloon: virtio, or `none` (left out, libvirt would add a virtio one). */
export function memballoonElement(enabled) {
  return { '@_model': enabled ? 'virtio' : 'none' };
}

export function guestAgentChannelElement() {
  return { '@_type': 'unix', target: { '@_type': 'virtio', '@_name': 'org.qemu.guest_agent.0' } };
}

/** Whether a `<channel>` is the guest agent's. */
export function isGuestAgentChannel(channel) {
  return String(channel?.target?.['@_name'] || '').includes('guest_agent');
}

export function tpmElement() {
  return { '@_model': 'tpm-tis', backend: { '@_type': 'emulator', '@_version': '2.0' } };
}

export function rngElement() {
  return { '@_model': 'virtio', backend: { '@_model': 'random', '#text': '/dev/urandom' } };
}

/** A host USB device passed through by vendor and product id (4 hex digits each). */
export function usbHostdevElement(vendorId, productId) {
  return {
    '@_mode': 'subsystem',
    '@_type': 'usb',
    '@_managed': 'yes',
    source: {
      vendor: { '@_id': `0x${vendorId}` },
      product: { '@_id': `0x${productId}` },
    },
  };
}
