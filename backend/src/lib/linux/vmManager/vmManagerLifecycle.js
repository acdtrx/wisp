/**
 * VM lifecycle: start, stop, force stop, reboot, suspend, resume.
 */
import { connectionState, resolveDomain, getDomainState, getDomainObjAndIface, vmError } from './vmManagerConnection.js';

export async function startVM(name) {
  const path = await resolveDomain(name);
  const state = await getDomainState(path);
  if (state.code === 1) throw vmError('VM_ALREADY_RUNNING', `VM "${name}" is already running`);

  const { iface } = await getDomainObjAndIface(path);
  try {
    await iface.Create(0);
    connectionState.vmStartTimes.set(name, Date.now());
  } catch (err) {
    throw vmError('LIBVIRT_ERROR', `Failed to start VM "${name}"`, err.message);
  }
}

export async function stopVM(name) {
  const path = await resolveDomain(name);
  const state = await getDomainState(path);
  if (state.code === 5) throw vmError('VM_NOT_RUNNING', `VM "${name}" is not running`);

  const { iface } = await getDomainObjAndIface(path);
  try {
    await iface.Shutdown(0);
  } catch (err) {
    throw vmError('LIBVIRT_ERROR', `Failed to stop VM "${name}"`, err.message);
  }
}

export async function forceStopVM(name) {
  const path = await resolveDomain(name);
  const state = await getDomainState(path);
  if (state.code === 5) throw vmError('VM_NOT_RUNNING', `VM "${name}" is not running`);

  const { iface } = await getDomainObjAndIface(path);
  try {
    await iface.Destroy(0);
    connectionState.vmStartTimes.delete(name);
    connectionState.prevVMStats.delete(name);
  } catch (err) {
    throw vmError('LIBVIRT_ERROR', `Failed to force stop VM "${name}"`, err.message);
  }
}

export async function rebootVM(name) {
  const path = await resolveDomain(name);
  const state = await getDomainState(path);
  if (state.code !== 1) throw vmError('VM_NOT_RUNNING', `VM "${name}" is not running`);

  const { iface } = await getDomainObjAndIface(path);
  try {
    await iface.Reboot(0);
  } catch (err) {
    throw vmError('LIBVIRT_ERROR', `Failed to reboot VM "${name}"`, err.message);
  }
}

export async function suspendVM(name) {
  const path = await resolveDomain(name);
  const state = await getDomainState(path);
  if (state.code !== 1) throw vmError('VM_NOT_RUNNING', `VM "${name}" must be running to suspend`);

  const { iface } = await getDomainObjAndIface(path);
  try {
    await iface.Suspend();
  } catch (err) {
    throw vmError('LIBVIRT_ERROR', `Failed to suspend VM "${name}"`, err.message);
  }
}

export async function resumeVM(name) {
  const path = await resolveDomain(name);
  const state = await getDomainState(path);
  if (state.code !== 3) throw vmError('VM_NOT_PAUSED', `VM "${name}" is not paused`);

  const { iface } = await getDomainObjAndIface(path);
  try {
    await iface.Resume();
    connectionState.vmStartTimes.set(name, connectionState.vmStartTimes.get(name) || Date.now());
  } catch (err) {
    throw vmError('LIBVIRT_ERROR', `Failed to resume VM "${name}"`, err.message);
  }
}
