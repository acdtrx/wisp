/**
 * USB passthrough: list attached, attach, detach.
 */
import { connectionState, resolveDomain, getDomainState, getDomainXML, getDomainObjAndIface, vmError } from './vmManagerConnection.js';
import { parseVMFromXML, buildXml } from './vmManagerXml.js';
import { redefineVM } from './vmManagerDefine.js';
import { usbHostdevElement } from './vmManagerDevices.js';
import { isShutOff } from './libvirtConstants.js';

function buildUsbDeviceXml(vendorId, productId) {
  return buildXml({ hostdev: usbHostdevElement(vendorId, productId) });
}

function hostdevList(dom) {
  return Array.isArray(dom.devices.hostdev) ? dom.devices.hostdev : dom.devices.hostdev ? [dom.devices.hostdev] : [];
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
  const isOn = !isShutOff(state.code);

  const deviceXml = buildUsbDeviceXml(vendorId, productId);

  if (isOn) {
    const { iface } = await getDomainObjAndIface(domPath);
    try {
      await iface.AttachDevice(deviceXml, 3);
    } catch (err) {
      throw vmError('USB_ATTACH_FAILED', `Failed to attach USB device ${vendorId}:${productId}`, err.message);
    }
  } else {
    await redefineVM(domPath, (dom) => {
      if (!dom.devices) throw vmError('USB_ATTACH_FAILED', 'Failed to parse domain XML');
      dom.devices.hostdev = [...hostdevList(dom), usbHostdevElement(vendorId, productId)];
    }, {
      defineError: (err) => vmError('USB_ATTACH_FAILED', `Failed to attach USB device ${vendorId}:${productId}`, err.message),
    });
  }
}

export async function detachUSBDevice(name, vendorId, productId) {
  if (!connectionState.connectIface) throw vmError('NO_CONNECTION', 'Not connected to libvirt');

  const domPath = await resolveDomain(name);
  const state = await getDomainState(domPath);
  const isOn = !isShutOff(state.code);

  const deviceXml = buildUsbDeviceXml(vendorId, productId);

  if (isOn) {
    const { iface } = await getDomainObjAndIface(domPath);
    try {
      await iface.DetachDevice(deviceXml, 3);
    } catch (err) {
      throw vmError('USB_DETACH_FAILED', `Failed to detach USB device ${vendorId}:${productId}`, err.message);
    }
  } else {
    await redefineVM(domPath, (dom) => {
      if (!dom.devices) throw vmError('USB_DETACH_FAILED', 'Failed to parse domain XML');
      const hostdevs = hostdevList(dom);
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
    }, {
      defineError: (err) => vmError('USB_DETACH_FAILED', `Failed to detach USB device ${vendorId}:${productId}`, err.message),
    });
  }
}
