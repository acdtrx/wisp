/**
 * USB passthrough: list attached, attach, detach.
 */
import { connectionState, resolveDomain, getDomainState, getDomainXML, getDomainObjAndIface, vmError } from './vmManagerConnection.js';
import { parseVMFromXML, parseDomainRaw, buildXml } from './vmManagerXml.js';

function buildUsbDeviceXml(vendorId, productId) {
  return buildXml({
    hostdev: {
      '@_mode': 'subsystem',
      '@_type': 'usb',
      '@_managed': 'yes',
      source: {
        vendor: { '@_id': `0x${vendorId}` },
        product: { '@_id': `0x${productId}` },
      },
    },
  });
}

export async function getVMUSBDevices(name) {
  const domPath = await resolveDomain(name);
  const xml = await getDomainXML(domPath);
  const config = parseVMFromXML(xml);
  if (!config) return [];

  const devices = [];
  for (const hd of (config._hostdevs || [])) {
    if (hd.type === 'usb' && hd.vendorId && hd.productId) {
      devices.push({ vendorId: hd.vendorId, productId: hd.productId });
    }
  }
  return devices;
}

export async function attachUSBDevice(name, vendorId, productId) {
  if (!connectionState.connectIface) throw vmError('NO_CONNECTION', 'Not connected to libvirt');

  const domPath = await resolveDomain(name);
  const state = await getDomainState(domPath);
  const isRunning = state.code === 1 || state.code === 2 || state.code === 3;

  const deviceXml = buildUsbDeviceXml(vendorId, productId);

  if (isRunning) {
    const { iface } = await getDomainObjAndIface(domPath);
    try {
      await iface.AttachDevice(deviceXml, 3);
    } catch (err) {
      throw vmError('USB_ATTACH_FAILED', `Failed to attach USB device ${vendorId}:${productId}`, err.message);
    }
  } else {
    const xml = await getDomainXML(domPath);
    const parsed = parseDomainRaw(xml);
    const dom = parsed.domain;
    if (!dom?.devices) throw vmError('USB_ATTACH_FAILED', 'Failed to parse domain XML', null);
    const hostdevs = Array.isArray(dom.devices.hostdev) ? dom.devices.hostdev : dom.devices.hostdev ? [dom.devices.hostdev] : [];
    hostdevs.push({
      '@_mode': 'subsystem',
      '@_type': 'usb',
      '@_managed': 'yes',
      source: {
        vendor: { '@_id': `0x${vendorId}` },
        product: { '@_id': `0x${productId}` },
      },
    });
    dom.devices.hostdev = hostdevs;
    try {
      await connectionState.connectIface.DomainDefineXML(buildXml(parsed));
    } catch (err) {
      throw vmError('USB_ATTACH_FAILED', `Failed to attach USB device ${vendorId}:${productId}`, err.message);
    }
  }
}

export async function detachUSBDevice(name, vendorId, productId) {
  if (!connectionState.connectIface) throw vmError('NO_CONNECTION', 'Not connected to libvirt');

  const domPath = await resolveDomain(name);
  const state = await getDomainState(domPath);
  const isRunning = state.code === 1 || state.code === 2 || state.code === 3;

  const deviceXml = buildUsbDeviceXml(vendorId, productId);

  if (isRunning) {
    const { iface } = await getDomainObjAndIface(domPath);
    try {
      await iface.DetachDevice(deviceXml, 3);
    } catch (err) {
      throw vmError('USB_DETACH_FAILED', `Failed to detach USB device ${vendorId}:${productId}`, err.message);
    }
  } else {
    const xml = await getDomainXML(domPath);
    const parsed = parseDomainRaw(xml);
    const dom = parsed.domain;
    if (!dom?.devices) throw vmError('USB_DETACH_FAILED', 'Failed to parse domain XML', null);
    const hostdevs = Array.isArray(dom.devices.hostdev) ? dom.devices.hostdev : dom.devices.hostdev ? [dom.devices.hostdev] : [];
    const vid = `0x${vendorId}`.toLowerCase();
    const pid = `0x${productId}`.toLowerCase();
    const filtered = hostdevs.filter((hd) => {
      if (hd['@_type'] !== 'usb') return true;
      const v = (hd.source?.vendor?.['@_id'] || '').toLowerCase();
      const p = (hd.source?.product?.['@_id'] || '').toLowerCase();
      return !(v === vid && p === pid);
    });
    if (filtered.length === hostdevs.length) {
      throw vmError('USB_DETACH_FAILED', `USB device ${vendorId}:${productId} not found on VM "${name}"`);
    }
    if (filtered.length) dom.devices.hostdev = filtered;
    else delete dom.devices.hostdev;
    try {
      await connectionState.connectIface.DomainDefineXML(buildXml(parsed));
    } catch (err) {
      throw vmError('USB_DETACH_FAILED', `Failed to detach USB device ${vendorId}:${productId}`, err.message);
    }
  }
}
