/**
 * VM lifecycle: start, stop, force stop, reboot, suspend, resume, and the
 * stop notification.
 */
import {
  connectionState,
  resolveDomain,
  getDomainState,
  getDomainObjAndIface,
  vmError,
  subscribeDomainStopped,
} from './vmManagerConnection.js';
import { isOfflineState } from './libvirtConstants.js';
import { getCachedVMName } from './vmManagerList.js';

const vmStoppedHandlers = new Set();

/**
 * Subscribe to VM stops: `handler(name)` once libvirt reports that a VM's QEMU
 * process ended (shut down, force stopped, crashed), whoever stopped it; by
 * then libvirt has removed the VM's tap devices. Fires for every stop; `name`
 * is the cached list's, null when the list does not know the domain. Only
 * fires with event watching; no replay. Returns an unsubscribe function.
 */
export function subscribeVMStopped(handler) {
  vmStoppedHandlers.add(handler);
  return () => vmStoppedHandlers.delete(handler);
}

// Named from the list, not read from libvirt: the domain may already be gone
// (a transient one, or a running VM's delete undefining it right after).
function announceVMStopped(domainPath) {
  const name = getCachedVMName(domainPath);
  for (const handler of vmStoppedHandlers) {
    try {
      handler(name);
    } catch (err) {
      connectionState.logger?.warn?.({ err: err?.message || err }, '[vmManager] vm-stopped handler threw');
    }
  }
}

subscribeDomainStopped(announceVMStopped);

/**
 * The checks a lifecycle call makes first, alone and quick, for a caller that
 * answers them before starting slow work: `start` (VM_NOT_FOUND,
 * VM_ALREADY_RUNNING), `running` (VM_NOT_FOUND, VM_NOT_RUNNING), `exists`
 * (VM_NOT_FOUND).
 * @param {string} name
 * @param {'start' | 'running' | 'exists'} what
 */
export async function assertVMState(name, what) {
  const path = await resolveDomain(name);
  if (what === 'exists') return;
  const state = await getDomainState(path);
  if (what === 'start' && state.code === 1) throw vmError('VM_ALREADY_RUNNING', `VM "${name}" is already running`);
  if (what === 'running' && isOfflineState(state.code)) throw vmError('VM_NOT_RUNNING', `VM "${name}" is not running`);
}

export async function startVM(name) {
  const path = await resolveDomain(name);
  const state = await getDomainState(path);
  if (state.code === 1) throw vmError('VM_ALREADY_RUNNING', `VM "${name}" is already running`);

  const { iface } = await getDomainObjAndIface(path);
  try {
    await iface.Create(0);
    connectionState.vmStartTimes.set(path, Date.now());
  } catch (err) {
    throw vmError('LIBVIRT_ERROR', `Failed to start VM "${name}"`, err.message);
  }
}

export async function stopVM(name) {
  const path = await resolveDomain(name);
  const state = await getDomainState(path);
  if (isOfflineState(state.code)) throw vmError('VM_NOT_RUNNING', `VM "${name}" is not running`);

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
  if (isOfflineState(state.code)) throw vmError('VM_NOT_RUNNING', `VM "${name}" is not running`);

  const { iface } = await getDomainObjAndIface(path);
  try {
    await iface.Destroy(0);
    connectionState.vmStartTimes.delete(path);
    connectionState.prevVMStats.delete(path);
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
    connectionState.vmStartTimes.set(path, connectionState.vmStartTimes.get(path) || Date.now());
  } catch (err) {
    throw vmError('LIBVIRT_ERROR', `Failed to resume VM "${name}"`, err.message);
  }
}
