/**
 * "A container's saved state changed": fired after every `container.json` write
 * (config, mounts, services, the restart flag, a rename under its new name, the
 * network probe's address) and after every write of a mount's content (upload,
 * zip extract, content edit, init, data delete, file mode). Handlers get the
 * container's name. No replay: it is a cue to read the container again.
 */
import { containerState } from './containerManagerConnection.js';
import { subscribeContainerConfigWrite } from './containerManagerConfigIo.js';

const containerChangeHandlers = new Set();

export function subscribeContainerChange(handler) {
  containerChangeHandlers.add(handler);
  return () => containerChangeHandlers.delete(handler);
}

export function announceContainerChange(name) {
  for (const handler of containerChangeHandlers) {
    try {
      handler(name);
    } catch (err) {
      containerState.logger?.warn?.({ err: err?.message || err }, '[containerManager] container-change handler threw');
    }
  }
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

subscribeContainerConfigWrite(announceContainerChange);
