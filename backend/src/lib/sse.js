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
 * Run `teardown` once the SSE client is gone. The response 'close' event fires
 * exactly once, so a listener attached after the client already left — during an
 * `await` in the handler, or before the handler ran (async auth hook) — would never
 * run and the stream's timers/subscriptions would leak. In that case `teardown`
 * runs immediately. Every SSE handler registers its teardown through this.
 * @param {import('fastify').FastifyReply} reply
 * @param {() => void} teardown
 */
export function onSSEClose(reply, teardown) {
  const raw = reply.raw;
  if (raw.destroyed) {
    teardown();
    return;
  }
  raw.once('close', teardown);
}

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
  onSSEClose(reply, () => {
    clearInterval(keepalive);
    activeSseResponses.delete(raw);
  });
  raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  // writeHead only stores the headers; Node sends them with the first body write.
  // A stream with nothing to say yet (a job before its first event) would leave
  // the client waiting for the response — and unable to tell 200 from a hang —
  // until the first event or keepalive.
  raw.flushHeaders();
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
