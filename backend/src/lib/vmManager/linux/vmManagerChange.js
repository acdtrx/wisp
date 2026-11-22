/**
 * "A VM's saved state changed": fired after every successful write vmManager
 * makes to a VM's definition or devices — config edits, disk, CD-ROM and USB
 * changes (hot-plug included, which libvirt announces with no DomainEvent),
 * resizes and restart-flag writes. Handlers get the VM's name (its new name
 * after a rename). No replay: it is a cue to read the VM again.
 */
import { connectionState } from './vmManagerConnection.js';
import { createEmitter } from '../../base/index.js';

const vmChange = createEmitter('[vmManager] vm-change', () => connectionState.logger);

export const subscribeVMChange = vmChange.subscribe;

export function announceVMChange(name) {
  vmChange.emit(name);
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

/** Notified after a VM backup was deleted (by any caller). No replay: a cue to
 *  read the backup lists again. */
const backupDeleted = createEmitter('[vmManager] backup-deleted', () => connectionState.logger);

export const subscribeVMBackupDeleted = backupDeleted.subscribe;

/** Wrap the backup delete so it announces itself once it succeeded. */
export function announcingVMBackupDeleted(deleteBackup) {
  return async (...args) => {
    const result = await deleteBackup(...args);
    backupDeleted.emit();
    return result;
  };
}
