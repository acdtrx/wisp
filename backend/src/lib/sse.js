/**
 * Server-Sent Events helpers for Fastify reply.
 */

/** @type { Set<import('node:http').ServerResponse> } */
const activeSseResponses = new Set();

/** Keepalive comment cadence — keeps NAT/proxy entries warm and lets the client's
 *  read-watchdog detect dead TCP without waiting for the next real event. Event-driven
 *  streams can sit idle for hours between pushes (e.g. /api/events with no host activity). */
const SSE_KEEPALIVE_MS = 25_000;

/**
 * Hijack the reply and set SSE headers. Call before writing to reply.raw.
 * Also starts a periodic comment-line keepalive on the connection.
 */
export function setupSSE(reply) {
  reply.hijack();
  const raw = reply.raw;
  activeSseResponses.add(raw);
  const keepalive = setInterval(() => {
    try {
      raw.write(': keepalive\n\n');
    } catch {
      /* socket already closed; close handler clears the interval */
    }
  }, SSE_KEEPALIVE_MS);
  raw.on('close', () => {
    clearInterval(keepalive);
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
