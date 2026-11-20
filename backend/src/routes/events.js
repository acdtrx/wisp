import { errorBody } from '../lib/appErrors.js';
import { buildHostStatsPayload } from '../lib/hostStatsSnapshot.js';
import { listVMs, subscribeVMListChange, subscribeVMChange } from '../lib/vmManager/index.js';
import {
  listContainers, subscribeContainerListChange, subscribeContainerChange, subscribeImagesChange,
} from '../lib/containerManager/index.js';
import { subscribeSectionsChange } from '../lib/sections.js';
import { subscribeHomepageChange } from '../lib/homepage.js';
import { buildHomeEnvelope } from '../lib/homeTiles.js';
import { getDiscoveredPeers, subscribeDiscoveredPeersChange } from '../lib/wispDiscovery.js';
import { getBackupStatus, subscribeBackupEvents } from '../lib/backupStatus.js';
import { subscribeSettingsChange, subscribeMountsChange } from '../lib/settings.js';
import { subscribeMountStateChange } from '../lib/storage/index.js';
import { subscribeCloudInitChange } from '../lib/cloudInit.js';
import { subscribeApiTokensChange } from '../lib/apiTokens.js';
import { subscribeNetworkBridgesChange } from '../lib/networking/index.js';
import { subscribeLibraryChange } from '../lib/library/index.js';
import { subscribeWispUpdateChange } from '../lib/wispUpdate.js';
import { listJobs, subscribeJobsChange } from '../lib/jobs/index.js';
import { onSSEClose, setupSSE } from '../lib/sse.js';
import { buildSectionsEnvelope } from './sections.js';
import { CHANGE_KIND, TOPIC } from '../../../shared/wireNames.js';

const HOST_STATS_INTERVAL_MS = 5000;

const TOPICS = new Set(Object.values(TOPIC));
const CHANGE_KINDS = new Set(Object.values(CHANGE_KIND));

/**
 * One frame of the events stream, as written to it. A topic or a change kind the
 * code passes in is checked against the wire's names (shared/wireNames.js), so a
 * typo fails the first time it runs rather than sending a frame no client reads.
 */
export function eventFrame(topic, data) {
  if (!TOPICS.has(topic)) throw new Error(`Unknown events topic: ${topic}`);
  if (topic === TOPIC.CHANGES && !CHANGE_KINDS.has(data?.kind)) throw new Error(`Unknown change kind: ${data?.kind}`);
  return `data: ${JSON.stringify({ topic, data })}\n\n`;
}

/**
 * The sender of an event-driven topic: each call gathers the topic and passes
 * `sendTopic(topic, data)` the payload, or, when the gather fails, the error
 * body after `logFailure(err)`. Gathers can finish out of order (two writes
 * close together), and a frame from a gather a later one overtook would bring
 * back the older state, so only the latest gather started sends its frame, its
 * error frame included.
 */
export function latestGatherSender(sendTopic, topic, gather, logFailure) {
  if (!TOPICS.has(topic)) throw new Error(`Unknown events topic: ${topic}`);
  let lastStarted = 0;
  return async function send() {
    const mine = ++lastStarted;
    let data;
    try {
      data = await gather();
    } catch (err) {
      logFailure(err);
      data = errorBody(err);
    }
    if (mine === lastStarted) sendTopic(topic, data);
  };
}

/**
 * GET /events — the single always-on SSE stream. Multiplexes every topic the
 * app needs continuously (host stats, VM list, container list, sections,
 * discovered peers, backups, the job list, change references) as
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
 * that fails to gather sends the error body `{ error, detail }` as its `data` and the
 * stream stays up for the others.
 */
export default async function eventsRoutes(fastify) {
  fastify.get('/events', {
    config: { auth: 'read', answers: 'sse' },
    handler: async (request, reply) => {
      setupSSE(reply);

      function sendTopic(topic, data) {
        const frame = eventFrame(topic, data);
        try {
          reply.raw.write(frame);
        } catch {
          /* client gone — the close handler below tears everything down */
        }
      }

      async function sendStats() {
        try {
          sendTopic(TOPIC.STATS, await buildHostStatsPayload());
        } catch (err) {
          fastify.log.error({ err }, 'events: failed to gather host stats');
          sendTopic(TOPIC.STATS, errorBody(err));
        }
      }

      const sendVMs = latestGatherSender(sendTopic, TOPIC.VMS, listVMs, (err) => {
        request.log.warn({ err: err.message }, 'events: listVMs failed');
      });

      const sendContainers = latestGatherSender(sendTopic, TOPIC.CONTAINERS, listContainers, (err) => {
        request.log.warn({ err: err.message }, 'events: listContainers failed');
      });

      const sendSections = latestGatherSender(sendTopic, TOPIC.SECTIONS, buildSectionsEnvelope, (err) => {
        request.log.warn({ err: err.message }, 'events: sections read failed');
      });

      /* Home page launcher tiles. Recomputed from live workload state joined with
       * the persisted overlay — so a container starting, a Caddy host being added,
       * or a tile being renamed all reach the page on the event that caused them.
       * No timer: every input has a change event of its own. */
      const sendHome = latestGatherSender(sendTopic, TOPIC.HOME, buildHomeEnvelope, (err) => {
        request.log.warn({ err: err.message }, 'events: home tiles build failed');
      });

      function sendDiscovery() {
        sendTopic(TOPIC.DISCOVERY, getDiscoveredPeers());
      }

      /* The job list, as GET /api/jobs answers it: a frame per list change
       * (a job created, ended, expired), never per progress event — a job's
       * progress stays on its own stream. */
      function sendJobs() {
        sendTopic(TOPIC.JOBS, { jobs: listJobs() });
      }

      /* Per-workload last-backup-attempt map. Fires on every backup-shaped
       * change (attempt recorded, backup deleted/pruned) — consumers also use
       * the frame as their cue to refetch the backup lists. */
      const sendBackups = latestGatherSender(sendTopic, TOPIC.BACKUPS, getBackupStatus, (err) => {
        request.log.warn({ err: err.message }, 'events: backup status read failed');
      });

      /* References to changed records that no other topic carries in full: a client
       * showing the record GETs it again. The connect snapshot is `{ kind: 'all' }` —
       * anything may have changed while this stream was down. */
      function sendChange(change) {
        sendTopic(TOPIC.CHANGES, change);
      }

      await Promise.all([
        sendStats(), sendVMs(), sendContainers(), sendSections(), sendBackups(), sendHome(),
      ]);
      sendDiscovery();
      sendJobs();
      sendChange({ kind: CHANGE_KIND.ALL });

      const statsTimer = setInterval(sendStats, HOST_STATS_INTERVAL_MS);
      const unsubscribes = [
        subscribeVMListChange(() => { sendVMs(); sendHome(); }),
        subscribeContainerListChange(() => { sendContainers(); sendHome(); }),
        subscribeSectionsChange(() => { sendSections(); }),
        subscribeHomepageChange(() => { sendHome(); }),
        subscribeDiscoveredPeersChange(() => { sendDiscovery(); }),
        subscribeJobsChange(() => { sendJobs(); }),
        subscribeBackupEvents(() => { sendBackups(); }),
        subscribeSettingsChange(() => { sendChange({ kind: CHANGE_KIND.SETTINGS }); }),
        subscribeVMChange((name) => { sendChange({ kind: CHANGE_KIND.VM, id: name }); }),
        subscribeContainerChange((name) => { sendChange({ kind: CHANGE_KIND.CONTAINER, id: name }); }),
        subscribeCloudInitChange((name) => { sendChange({ kind: CHANGE_KIND.VM, id: name }); }),
        subscribeApiTokensChange(() => { sendChange({ kind: CHANGE_KIND.TOKENS }); }),
        subscribeNetworkBridgesChange(() => { sendChange({ kind: CHANGE_KIND.NETWORK_BRIDGES }); }),
        subscribeMountsChange(() => { sendChange({ kind: CHANGE_KIND.HOST_MOUNTS }); }),
        subscribeMountStateChange(() => { sendChange({ kind: CHANGE_KIND.HOST_MOUNTS }); }),
        subscribeImagesChange(() => { sendChange({ kind: CHANGE_KIND.IMAGES }); }),
        subscribeLibraryChange(() => { sendChange({ kind: CHANGE_KIND.LIBRARY }); }),
        subscribeWispUpdateChange(() => { sendChange({ kind: CHANGE_KIND.WISP_UPDATE }); }),
      ];

      onSSEClose(reply, () => {
        clearInterval(statsTimer);
        for (const unsubscribe of unsubscribes) unsubscribe();
      });
    },
  });
}
