import { setupSSE } from '../lib/sse.js';
import { getDiscoveredPeers, subscribeDiscoveredPeersChange } from '../lib/wispDiscovery.js';

export default async function discoveryRoutes(fastify) {
  // GET /discovery/stream — SSE endpoint for the discovered-peer list.
  // Pushes on avahi browse events (peer appeared/left/avahi restart); no
  // polling timer. Payload is a bare array of { name, url, version, host }.
  fastify.get('/discovery/stream', {
    schema: { hide: true },
    handler: async (request, reply) => {
      setupSSE(reply);

      function sendPeers() {
        try {
          reply.raw.write(`data: ${JSON.stringify(getDiscoveredPeers())}\n\n`);
        } catch (err) {
          request.log.warn({ err: err?.message || err }, 'discovery/stream write failed');
        }
      }

      sendPeers();
      const unsubscribe = subscribeDiscoveredPeersChange(sendPeers);

      request.raw.on('close', () => {
        unsubscribe();
      });
    },
  });
}
