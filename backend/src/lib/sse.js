/**
 * Server-Sent Events helpers for Fastify reply.
 */

/** @type { Set<import('node:http').ServerResponse> } */
const activeSseResponses = new Set();

/**
 * Hijack the reply and set SSE headers. Call before writing to reply.raw.
 */
export function setupSSE(reply) {
  reply.hijack();
  const raw = reply.raw;
  activeSseResponses.add(raw);
  raw.on('close', () => {
    activeSseResponses.delete(raw);
  });
  raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
}

/**
 * End all active SSE connections so the process can exit on SIGTERM.
 */
export function closeAllSSE() {
  const list = [...activeSseResponses];
  activeSseResponses.clear();
  for (const res of list) {
    try {
      if (!res.writableEnded) res.end();
    } catch {
      // Socket may already be half-closed
    }
  }
}
