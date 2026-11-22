/**
 * "A container's saved state changed": fired after every `container.json` write
 * (config, mounts, services, the restart flag, a rename under its new name, the
 * network probe's address) and after every write of a mount's content (upload,
 * zip extract, content edit, init, data delete, file mode). Handlers get the
 * container's name. No replay: it is a cue to read the container again.
 */
import { containerState } from './containerManagerConnection.js';
import { subscribeContainerConfigWrite } from './containerManagerConfigIo.js';
import { createEmitter } from '../../base/index.js';

const containerChange = createEmitter('[containerManager] container-change', () => containerState.logger);

export const subscribeContainerChange = containerChange.subscribe;

export function announceContainerChange(name) {
  containerChange.emit(name);
}

/** Wrap a mount-content mutation so it announces the change once it succeeded.
 *  `changedName` picks the container's name from the call (default: the first argument). */
export function announcingContainerChange(mutation, changedName = (args) => args[0]) {
  return async (...args) => {
    const result = await mutation(...args);
    announceContainerChange(changedName(args));
    return result;
  };
}

/** Notified after a container backup was deleted (by any caller: the route, the
 *  scheduler's retention). No replay: a cue to read the backup lists again. */
const backupDeleted = createEmitter('[containerManager] backup-deleted', () => containerState.logger);

export const subscribeContainerBackupDeleted = backupDeleted.subscribe;

/** Wrap the backup delete so it announces itself once it succeeded. */
export function announcingContainerBackupDeleted(deleteBackup) {
  return async (...args) => {
    const result = await deleteBackup(...args);
    backupDeleted.emit();
    return result;
  };
}

subscribeContainerConfigWrite(announceContainerChange);
