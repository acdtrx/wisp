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
import { isShutOff, VIR_DOMAIN_STATE_RUNNING, VIR_DOMAIN_STATE_PAUSED } from './libvirtConstants.js';
import { getCachedVMName } from './vmManagerList.js';
import { createEmitter } from '../../base/index.js';

const vmStopped = createEmitter('[vmManager] vm-stopped', () => connectionState.logger);

/**
 * Subscribe to VM stops: `handler(name)` once libvirt reports that a VM's QEMU
 * process ended (shut down, force stopped, crashed), whoever stopped it; by
 * then libvirt has removed the VM's tap devices. Fires for every stop; `name`
 * is the cached list's, null when the list does not know the domain. Only
 * fires with event watching; no replay. Returns an unsubscribe function.
 */
export const subscribeVMStopped = vmStopped.subscribe;

// Named from the list, not read from libvirt: the domain may already be gone
// (a transient one, or a running VM's delete undefining it right after).
function announceVMStopped(domainPath) {
  vmStopped.emit(getCachedVMName(domainPath));
}

subscribeDomainStopped(announceVMStopped);

/**
 * The checks a lifecycle call makes first, alone and quick, for a caller that
 * answers them before starting slow work: `start` (VM_NOT_FOUND,
 * VM_ALREADY_RUNNING), `running` (VM_NOT_FOUND, VM_NOT_RUNNING when shut off:
 * a force stop's test), `stop` (VM_NOT_FOUND, VM_NOT_RUNNING in any state but
 * running: a paused guest cannot act on a shutdown request), `exists`
 * (VM_NOT_FOUND).
 * @param {string} name
 * @param {'start' | 'running' | 'stop' | 'exists'} what
 */
export async function assertVMState(name, what) {
  const path = await resolveDomain(name);
  if (what === 'exists') return;
  const state = await getDomainState(path);
  if (what === 'start' && state.code === VIR_DOMAIN_STATE_RUNNING) throw vmError('VM_ALREADY_RUNNING', `VM "${name}" is already running`);
  if (what === 'running' && isShutOff(state.code)) throw vmError('VM_NOT_RUNNING', `VM "${name}" is not running`);
  if (what === 'stop' && state.code !== VIR_DOMAIN_STATE_RUNNING) throw vmError('VM_NOT_RUNNING', `VM "${name}" is not running`);
}

export async function startVM(name) {
  const path = await resolveDomain(name);
  const state = await getDomainState(path);
  if (state.code === VIR_DOMAIN_STATE_RUNNING) throw vmError('VM_ALREADY_RUNNING', `VM "${name}" is already running`);

  const { iface } = await getDomainObjAndIface(path);
  try {
    await iface.Create(0);
    connectionState.vmStartTimes.set(path, Date.now());
  } catch (err) {
    throw vmError('LIBVIRT_ERROR', `Failed to start VM "${name}"`, err.message);
  }
}

/** Ask the guest to shut down (ACPI); answers once libvirt has sent the request. */
export async function stopVM(name) {
  const path = await resolveDomain(name);
  const state = await getDomainState(path);
  if (state.code !== VIR_DOMAIN_STATE_RUNNING) throw vmError('VM_NOT_RUNNING', `VM "${name}" is not running`);

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
  if (isShutOff(state.code)) throw vmError('VM_NOT_RUNNING', `VM "${name}" is not running`);

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
  if (state.code !== VIR_DOMAIN_STATE_RUNNING) throw vmError('VM_NOT_RUNNING', `VM "${name}" is not running`);

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
  if (state.code !== VIR_DOMAIN_STATE_RUNNING) throw vmError('VM_NOT_RUNNING', `VM "${name}" must be running to suspend`);

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
  if (state.code !== VIR_DOMAIN_STATE_PAUSED) throw vmError('VM_NOT_PAUSED', `VM "${name}" is not paused`);

  const { iface } = await getDomainObjAndIface(path);
  try {
    await iface.Resume();
    connectionState.vmStartTimes.set(path, connectionState.vmStartTimes.get(path) || Date.now());
  } catch (err) {
    throw vmError('LIBVIRT_ERROR', `Failed to resume VM "${name}"`, err.message);
  }
}
