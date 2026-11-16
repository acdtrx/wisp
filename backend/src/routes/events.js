import { buildHostStatsPayload } from '../lib/hostStatsSnapshot.js';
import { listVMs, subscribeVMListChange, subscribeVMChange } from '../lib/vmManager/index.js';
import { listContainers, subscribeContainerListChange, subscribeContainerChange } from '../lib/containerManager/index.js';
import { subscribeSectionsChange } from '../lib/sections.js';
import { subscribeHomepageChange } from '../lib/homepage.js';
import { buildHomeEnvelope } from '../lib/homeTiles.js';
import { getDiscoveredPeers, subscribeDiscoveredPeersChange } from '../lib/wispDiscovery.js';
import { getBackupStatus, subscribeBackupEvents } from '../lib/backupStatus.js';
import { subscribeSettingsChange } from '../lib/settings.js';
import { subscribeCloudInitChange } from '../lib/cloudInit.js';
import { subscribeApiTokensChange } from '../lib/apiTokens.js';
import { onSSEClose, setupSSE } from '../lib/sse.js';
import { buildSectionsEnvelope } from './sections.js';

const HOST_STATS_INTERVAL_MS = 5000;

/**
 * GET /events — the single always-on SSE stream. Multiplexes every topic the
 * app needs continuously (host stats, VM list, container list, sections,
 * discovered peers, backups, change references) as
 * `data: {"topic": <name>, "data": <payload>}` frames.
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
 * endpoints: stats on a 5s timer; vms/containers/sections/home/discovery pushed
 * on their change events; every topic replays a snapshot on connect. A topic
 * that fails to gather sends `{ error, detail, code }` as its `data` and the
 * stream stays up for the others.
 */
export default async function eventsRoutes(fastify) {
  fastify.get('/events', {
    config: { auth: 'read' },
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

      /* An event-driven topic's gathers can finish out of order (two writes close
       * together); a frame from a gather a later one overtook would bring back the
       * older state. So only the latest gather started for a topic sends its frame,
       * its error frame included. */
      function latestGatherSender(topic, gather, describeFailure) {
        let lastStarted = 0;
        return async function send() {
          const mine = ++lastStarted;
          let data;
          try {
            data = await gather();
          } catch (err) {
            data = describeFailure(err);
          }
          if (mine === lastStarted) sendTopic(topic, data);
        };
      }

      const sendVMs = latestGatherSender('vms', listVMs, (err) => {
        request.log.warn({ err: err.message }, 'events: listVMs failed');
        return { error: err.message, detail: err.raw || err.message, code: err.code };
      });

      const sendContainers = latestGatherSender('containers', listContainers, (err) => {
        request.log.warn({ err: err.message }, 'events: listContainers failed');
        return { error: 'Failed to list containers', detail: err.raw || err.message, code: err.code };
      });

      const sendSections = latestGatherSender('sections', buildSectionsEnvelope, (err) => {
        request.log.warn({ err: err.message }, 'events: sections read failed');
        return { error: err.message, detail: err.raw || err.message, code: err.code };
      });

      /* Home page launcher tiles. Recomputed from live workload state joined with
       * the persisted overlay — so a container starting, a Caddy host being added,
       * or a tile being renamed all reach the page on the event that caused them.
       * No timer: every input has a change event of its own. */
      const sendHome = latestGatherSender('home', buildHomeEnvelope, (err) => {
        request.log.warn({ err: err.message }, 'events: home tiles build failed');
        return { error: err.message, detail: err.raw || err.message, code: err.code };
      });

      function sendDiscovery() {
        sendTopic('discovery', getDiscoveredPeers());
      }

      /* Per-workload last-backup-attempt map. Fires on every backup-shaped
       * change (attempt recorded, backup deleted/pruned) — consumers also use
       * the frame as their cue to refetch the backup lists. */
      const sendBackups = latestGatherSender('backups', getBackupStatus, (err) => {
        request.log.warn({ err: err.message }, 'events: backup status read failed');
        return { error: err.message, detail: err.raw || err.message, code: err.code };
      });

      /* References to changed records that no other topic carries in full: a client
       * showing the record GETs it again. The connect snapshot is `{ kind: 'all' }` —
       * anything may have changed while this stream was down. */
      function sendChange(change) {
        sendTopic('changes', change);
      }

      await Promise.all([
        sendStats(), sendVMs(), sendContainers(), sendSections(), sendBackups(), sendHome(),
      ]);
      sendDiscovery();
      sendChange({ kind: 'all' });

      const statsTimer = setInterval(sendStats, HOST_STATS_INTERVAL_MS);
      const unsubscribes = [
        subscribeVMListChange(() => { sendVMs(); sendHome(); }),
        subscribeContainerListChange(() => { sendContainers(); sendHome(); }),
        subscribeSectionsChange(() => { sendSections(); }),
        subscribeHomepageChange(() => { sendHome(); }),
        subscribeDiscoveredPeersChange(() => { sendDiscovery(); }),
        subscribeBackupEvents(() => { sendBackups(); }),
        subscribeSettingsChange(() => { sendChange({ kind: 'settings' }); }),
        subscribeVMChange((name) => { sendChange({ kind: 'vm', id: name }); }),
        subscribeContainerChange((name) => { sendChange({ kind: 'container', id: name }); }),
        subscribeCloudInitChange((name) => { sendChange({ kind: 'vm', id: name }); }),
        subscribeApiTokensChange(() => { sendChange({ kind: 'tokens' }); }),
      ];

      onSSEClose(reply, () => {
        clearInterval(statsTimer);
        for (const unsubscribe of unsubscribes) unsubscribe();
      });
    },
  });
}
