/**
 * The base every backend module may import — strict managers, carved modules
 * and glue alike: it imports only Node builtins. The one change emitter the
 * one way to run something as root, and the one atomic file write.
 */
export { createEmitter } from './emitter.js';
export { runPrivileged, helperPath, HELPER_DIR, PrivilegedError } from './privileged.js';
export { writeFileAtomic, writeJsonAtomic, atomicTmpName, ATOMIC_TMP_SUFFIX_RE } from './atomicWrite.js';
