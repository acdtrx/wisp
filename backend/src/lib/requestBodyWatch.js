/**
 * Body-inactivity bound for requests whose body can be large (uploads, mount
 * content writes): no total bound — a large file on a slow link takes as long
 * as it takes — but the request is dropped after REQUEST_BODY_IDLE_MS without
 * body bytes (CODING-RULES §6).
 */
import { createStallWatchdog } from './storage/index.js';

export const REQUEST_BODY_IDLE_MS = 60_000;

/**
 * Destroy `request`'s socket after `idleMs` without body bytes. Returns the
 * watchdog (stop it once the body is read). Progress is the socket's byte
 * count: a 'data' listener on the request would switch it to flowing mode and
 * take the body from its parser.
 */
export function watchRequestBody(request, idleMs = REQUEST_BODY_IDLE_MS) {
  const { socket } = request.raw;
  const watchdog = createStallWatchdog({
    stallMs: idleMs,
    probe: async () => socket?.bytesRead,
    onStall: () => request.raw.destroy(new Error(`upload made no progress for ${idleMs / 1000} s`)),
  });
  request.raw.once('close', watchdog.stop);
  return watchdog;
}

/**
 * Route hooks for a body Fastify parses before the handler (JSON): the watch
 * starts on the request and stops once the handler is done with it.
 */
export const bodyWatchHooks = {
  onRequest: async (request) => {
    request.bodyWatch = watchRequestBody(request);
  },
  onResponse: async (request) => {
    request.bodyWatch?.stop();
  },
};
