import { api } from './client.js';

export function listVMs() {
  return api('/api/vms');
}

export function createVM(spec) {
  return api('/api/vms', { method: 'POST', body: spec });
}

export function getVM(name) {
  return api(`/api/vms/${encodeURIComponent(name)}`);
}

export function updateVM(name, changes) {
  return api(`/api/vms/${encodeURIComponent(name)}`, { method: 'PATCH', body: changes });
}

export function getVMXML(name) {
  return api(`/api/vms/${encodeURIComponent(name)}/xml`);
}

export function startVM(name) {
  return api(`/api/vms/${encodeURIComponent(name)}/start`, { method: 'POST' });
}

export function stopVM(name) {
  return api(`/api/vms/${encodeURIComponent(name)}/stop`, { method: 'POST' });
}

export function forceStopVM(name) {
  return api(`/api/vms/${encodeURIComponent(name)}/force-stop`, { method: 'POST' });
}

export function rebootVM(name) {
  return api(`/api/vms/${encodeURIComponent(name)}/reboot`, { method: 'POST' });
}

export function suspendVM(name) {
  return api(`/api/vms/${encodeURIComponent(name)}/suspend`, { method: 'POST' });
}

export function resumeVM(name) {
  return api(`/api/vms/${encodeURIComponent(name)}/resume`, { method: 'POST' });
}

export function cloneVM(name, newName) {
  return api(`/api/vms/${encodeURIComponent(name)}/clone`, { method: 'POST', body: { newName } });
}

export function deleteVM(name, deleteDisks = false) {
  return api(`/api/vms/${encodeURIComponent(name)}?deleteDisks=${deleteDisks}`, { method: 'DELETE' });
}

// Disk operations
export function attachDiskToVM(name, slot, path, bus = 'virtio') {
  return api(`/api/vms/${encodeURIComponent(name)}/disks`, { method: 'POST', body: { slot, path, bus } });
}

export function createDiskOnVM(name, slot, sizeGB, bus = 'virtio') {
  return api(`/api/vms/${encodeURIComponent(name)}/disks`, { method: 'POST', body: { slot, sizeGB, bus } });
}

export function detachDiskFromVM(name, slot) {
  return api(`/api/vms/${encodeURIComponent(name)}/disks/${encodeURIComponent(slot)}`, { method: 'DELETE' });
}

export function resizeDisk(name, slot, sizeGB) {
  return api(`/api/vms/${encodeURIComponent(name)}/disks/${encodeURIComponent(slot)}/resize`, { method: 'POST', body: { sizeGB } });
}

export function updateDiskBus(name, slot, bus) {
  return api(`/api/vms/${encodeURIComponent(name)}/disks/${encodeURIComponent(slot)}/bus`, { method: 'POST', body: { bus } });
}

// CDROM operations
export function attachISO(name, slot, path) {
  return api(`/api/vms/${encodeURIComponent(name)}/cdrom/${encodeURIComponent(slot)}`, { method: 'POST', body: { path } });
}

export function ejectISO(name, slot) {
  return api(`/api/vms/${encodeURIComponent(name)}/cdrom/${encodeURIComponent(slot)}`, { method: 'DELETE' });
}

// USB operations
export function getVMUSB(name) {
  return api(`/api/vms/${encodeURIComponent(name)}/usb`);
}

export function attachUSBToVM(name, vendorId, productId) {
  return api(`/api/vms/${encodeURIComponent(name)}/usb`, { method: 'POST', body: { vendorId, productId } });
}

export function detachUSBFromVM(name, vendorId, productId) {
  return api(`/api/vms/${encodeURIComponent(name)}/usb/${encodeURIComponent(vendorId)}:${encodeURIComponent(productId)}`, { method: 'DELETE' });
}

// Host queries
export function getHostBridges() {
  return api('/api/host/bridges');
}

// Cloud-Init
export function getCloudInit(name) {
  return api(`/api/vms/${encodeURIComponent(name)}/cloudinit`);
}

export function updateCloudInit(name, config) {
  return api(`/api/vms/${encodeURIComponent(name)}/cloudinit`, { method: 'PUT', body: config });
}

export function deleteCloudInit(name) {
  return api(`/api/vms/${encodeURIComponent(name)}/cloudinit`, { method: 'DELETE' });
}

export function fetchGithubKeys(username) {
  return api(`/api/github/keys/${encodeURIComponent(username)}`);
}

export function getVMSnapshots(name) {
  return api(`/api/vms/${encodeURIComponent(name)}/snapshots`);
}

export function createVMSnapshot(name, snapshotName) {
  return api(`/api/vms/${encodeURIComponent(name)}/snapshots`, { method: 'POST', body: { name: snapshotName } });
}

export function revertVMSnapshot(name, snapshotName) {
  return api(`/api/vms/${encodeURIComponent(name)}/snapshots/${encodeURIComponent(snapshotName)}/revert`, { method: 'POST' });
}

export function deleteVMSnapshot(name, snapshotName) {
  return api(`/api/vms/${encodeURIComponent(name)}/snapshots/${encodeURIComponent(snapshotName)}`, { method: 'DELETE' });
}
