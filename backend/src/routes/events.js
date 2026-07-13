import { buildHostStatsPayload } from '../lib/hostStatsSnapshot.js';
import { listVMs, subscribeVMListChange } from '../lib/vmManager/index.js';
import { listContainers, subscribeContainerListChange } from '../lib/containerManager/index.js';
import { subscribeSectionsChange } from '../lib/sections.js';
import { getDiscoveredPeers, subscribeDiscoveredPeersChange } from '../lib/wispDiscovery.js';
import { setupSSE } from '../lib/sse.js';
import { buildSectionsEnvelope } from './sections.js';

const HOST_STATS_INTERVAL_MS = 5000;

/**
 * GET /events — the single always-on SSE stream. Multiplexes every topic the
 * app needs continuously (host stats, VM list, container list, sections,
 * discovered peers) as `data: {"topic": <name>, "data": <payload>}` frames.
 *
 * One stream instead of five: browsers cap plain-HTTP/1.1 connections at 6
 * per origin, and each SSE stream holds one for its lifetime. With per-topic
 * streams, a detail page (or Host Mgmt with its disks stream) reached the cap
 * and every further fetch queued in the browser forever. Behind an HTTP/2
 * proxy the cap never bites, but direct `http://host:8080` access is the
 * stock deployment. Scoped streams (per-entity stats, logs, disks, usb, job
 * progress) stay separate — they are transient and bounded well below the cap.
 *
 * Per-topic payloads and cadence are unchanged from the former dedicated
 * endpoints: stats on a 5s timer; vms/containers/sections/discovery pushed on
 * their change events; every topic replays a snapshot on connect. A topic
 * that fails to gather sends `{ error, detail, code }` as its `data` and the
 * stream stays up for the others.
 */
export default async function eventsRoutes(fastify) {
  fastify.get('/events', {
    schema: { hide: true },
    handler: async (request, reply) => {
      setupSSE(reply);

      function sendTopic(topic, data) {
        try {
          reply.raw.write(`data: ${JSON.stringify({ topic, data })}\n\n`);
        } catch {
          /* client gone — the close handler below tears everything down */
        }
      }

      async function sendStats() {
        try {
          sendTopic('stats', await buildHostStatsPayload());
        } catch (err) {
          fastify.log.error({ err }, 'events: failed to gather host stats');
          sendTopic('stats', { error: 'Failed to gather stats', detail: err.raw || err.message, code: err.code });
        }
      }

      async function sendVMs() {
        try {
          sendTopic('vms', await listVMs());
        } catch (err) {
          request.log.warn({ err: err.message }, 'events: listVMs failed');
          sendTopic('vms', { error: err.message, detail: err.raw || err.message, code: err.code });
        }
      }

      async function sendContainers() {
        try {
          sendTopic('containers', await listContainers());
        } catch (err) {
          request.log.warn({ err: err.message }, 'events: listContainers failed');
          sendTopic('containers', { error: 'Failed to list containers', detail: err.raw || err.message, code: err.code });
        }
      }

      async function sendSections() {
        try {
          sendTopic('sections', await buildSectionsEnvelope());
        } catch (err) {
          request.log.warn({ err: err.message }, 'events: sections read failed');
          sendTopic('sections', { error: err.message, detail: err.raw || err.message, code: err.code });
        }
      }

      function sendDiscovery() {
        sendTopic('discovery', getDiscoveredPeers());
      }

      await Promise.all([sendStats(), sendVMs(), sendContainers(), sendSections()]);
      sendDiscovery();

      const statsTimer = setInterval(sendStats, HOST_STATS_INTERVAL_MS);
      const unsubscribes = [
        subscribeVMListChange(() => { sendVMs(); }),
        subscribeContainerListChange(() => { sendContainers(); }),
        subscribeSectionsChange(() => { sendSections(); }),
        subscribeDiscoveredPeersChange(() => { sendDiscovery(); }),
      ];

      request.raw.on('close', () => {
        clearInterval(statsTimer);
        for (const unsubscribe of unsubscribes) unsubscribe();
      });
    },
  });
}
