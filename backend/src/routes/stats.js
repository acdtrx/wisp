import { buildHostStatsPayload } from '../lib/hostStatsSnapshot.js';
import { setupSSE } from '../lib/sse.js';

export default async function statsRoutes(fastify) {
  fastify.get('/stats', {
    schema: { hide: true },
    handler: async (request, reply) => {
      setupSSE(reply);

      async function sendStats() {
        try {
          const payload = await buildHostStatsPayload();
          reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
        } catch (err) {
          fastify.log.error({ err }, 'Failed to gather stats');
          const errPayload = {
            error: 'Failed to gather stats',
            detail: err.raw || err.message,
            code: err.code,
          };
          try { reply.raw.write(`data: ${JSON.stringify(errPayload)}\n\n`); }
          catch { /* client gone — interval will be cleared on close */ }
        }
      }

      await sendStats();
      const interval = setInterval(sendStats, 5000);

      request.raw.on('close', () => {
        clearInterval(interval);
      });
    },
  });
}
