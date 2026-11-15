/**
 * "A VM's saved state changed": fired after every successful write vmManager
 * makes to a VM's definition or devices — config edits, disk, CD-ROM and USB
 * changes (hot-plug included, which libvirt announces with no DomainEvent),
 * resizes and restart-flag writes. Handlers get the VM's name (its new name
 * after a rename). No replay: it is a cue to read the VM again.
 */
import { connectionState } from './vmManagerConnection.js';

const vmChangeHandlers = new Set();

export function subscribeVMChange(handler) {
  vmChangeHandlers.add(handler);
  return () => vmChangeHandlers.delete(handler);
}

export function announceVMChange(name) {
  for (const handler of vmChangeHandlers) {
    try {
      handler(name);
    } catch (err) {
      connectionState.logger?.warn?.({ err: err?.message || err }, '[vmManager] vm-change handler threw');
    }
  }
}

/**
 * Wrap a mutation so it announces the change once it succeeded. `changedName`
 * picks the VM's name from the call (default: the first argument) and may
 * return null when the call changed nothing.
 */
export function announcingVMChange(mutation, changedName = (args) => args[0]) {
  return async (...args) => {
    const result = await mutation(...args);
    const name = changedName(args, result);
    if (name) announceVMChange(name);
    return result;
  };
}
