/**
 * The base every backend module may import — strict managers, carved modules
 * and glue alike: it imports only Node builtins. The one change emitter and
 * the one way to run something as root.
 */
export { createEmitter } from './emitter.js';
export { runPrivileged, helperPath, HELPER_DIR, PrivilegedError } from './privileged.js';
