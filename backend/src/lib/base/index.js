/**
 * The base every backend module may import — strict managers, carved modules
 * and glue alike: it imports only Node builtins. The one change emitter.
 */
export { createEmitter } from './emitter.js';
