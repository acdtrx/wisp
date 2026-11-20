/**
 * Container API routes: CRUD, lifecycle, mount content, stats SSE, logs SSE.
 */
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import {
  getContainerDir, assertContainerState,
  listContainers, getContainerConfig, getContainerMountUsage, assertContainerNameAvailable, createContainer, renameContainer,
  createContainerBackup,
  killContainer,
  updateContainerConfig, addContainerMount, updateContainerMount, removeContainerMount,
  addContainerService, updateContainerService, removeContainerService,
  getContainerStats,
  listContainerRuns, readRunLogHistory, streamContainerRunLogs, resolveRunId,
  createRunLogReadStream,
  planMountFileUpload, commitMountFileUpload, assertMountTakesZip, planMountZipExtract, extractMountZip,
  initMountContent, assertMountOperation, deleteMountData, deleteRemovedMountData,
  getMountFileTextContent, putMountFileTextContent,
  listContainerImages, assertContainerImageDeletable, deleteContainerImage,
  getImageUpdateStatus,
} from '../lib/containerManager/index.js';
import {
  startJob,
  BACKGROUND_JOB_KIND,
  titleForContainerCreate,
  titleForContainerBackup,
  titleForContainerMountDelete,
  titleForContainerMountDataDelete,
  titleForContainerImageDelete,
  titleForZipExtract,
} from '../lib/jobs/index.js';
import { startContainerLifecycleJob, startContainerDeleteJob } from '../lib/containerJobs.js';
import { startImageUpdateCheckJob } from '../lib/updateChecks.js';
import { watchRequestBody, bodyWatchHooks } from '../lib/requestBodyWatch.js';
import { getSettings, getRawMounts } from '../lib/settings.js';
import { renameWorkloadAssignment } from '../lib/sections.js';
import { publishContainer, unpublishContainer } from '../lib/containerMdnsReconciler.js';
import { resolveBackupDestinations, backupToEachDestination } from '../lib/backupDestinations.js';
import { recordBackupAttempt } from '../lib/backupStatus.js';
import { onSSEClose, setupSSE, writeSSEError } from '../lib/sse.js';
import { createAppError } from '../lib/appErrors.js';
import { validateContainerName } from '../lib/validation.js';
import {
  acquireContainerOperationLock,
  withContainerOperationLock,
} from '../lib/containerOperationLock.js';
import {
  isKnownApp,
  createAppContainer,
  applyAppConfig,
  eject as ejectAppContainer,
  maskContainerConfigSecrets,
  assertMountNotAppManaged,
  assertMountListNotAppManaged,
  assertMountContentReadable,
} from '../lib/containerApps/index.js';
import { jobAckSchema } from './schemas.js';

/** Staging file for one mount upload: inside the container dir, so on the same disk as the mount data (not a tmpfs /tmp). */
function mountUploadStagingPath(containerName) {
  return join(getContainerDir(containerName), `.wisp-upload-${randomBytes(8).toString('hex')}`);
}

/**
 * Stream the request's single file part to `stagingPath` while iterating the
 * parts; resolves whether a file part was present. The caller owns (and always
 * removes) the staging file.
 *
 * The file must be consumed as it arrives. busboy finishes the multipart body
 * only after every file stream has been read to its end, and @fastify/multipart
 * >= 10.1 ends the parts iterator only when busboy finishes — so holding a file
 * part unread while looking for more parts never completes (10.0 ended the
 * iterator on the request's 'close', which only came once the whole body fit in
 * stream buffers, so it worked for small files only).
 *
 * Staging, rather than streaming straight into the mount, keeps rejections
 * deterministic: fields are ignored, a second file part is drained and answers
 * BAD_MULTIPART_TOO_MANY_FILES once the body is read, and an upload over the
 * multipart fileSize limit answers UPLOAD_TOO_LARGE — in each case before the
 * mount is touched.
 */
async function stageSingleMultipartFile(request, stagingPath, { mode = 0o600 } = {}) {
  let staged = false;
  let extraFiles = false;
  try {
    for await (const part of request.parts()) {
      if (part.type !== 'file') continue;
      if (staged) {
        extraFiles = true;
        part.file.resume();
        continue;
      }
      staged = true;
      await pipeline(part.file, createWriteStream(stagingPath, { mode, flags: 'wx' }));
      if (part.file.truncated) throw uploadTooLargeError();
    }
  } catch (err) {
    // An over-limit extra file part surfaces as the iterator's own error.
    if (err.code === 'FST_REQ_FILE_TOO_LARGE') throw uploadTooLargeError();
    throw err;
  }
  if (extraFiles) {
    throw createAppError(
      'BAD_MULTIPART_TOO_MANY_FILES',
      'Only one file upload is allowed per request',
    );
  }
  return staged;
}

function uploadTooLargeError() {
  return createAppError('UPLOAD_TOO_LARGE', 'File too large', 'Upload exceeded the configured size limit');
}

export default async function containerRoutes(fastify) {
  fastify.addHook('preHandler', async (request) => {
    const name = request.params?.name;
    if (name === undefined) return;
    validateContainerName(name);
  });

  // ── List ──────────────────────────────────────────────────────────
  fastify.get('/containers', {
    config: { auth: 'read' },
    schema: {
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              uuid: { type: ['string', 'null'] },
              type: { type: 'string' },
              image: { type: 'string' },
              state: { type: 'string' },
              iconId: { type: ['string', 'null'] },
              autoBackup: { type: 'boolean' },
              updateAvailable: { type: 'boolean' },
              scheduledRestart: {
                type: ['object', 'null'],
                properties: {
                  attempt: { type: 'integer' },
                  at: { type: 'number' },
                },
              },
              pendingRestart: {
                type: ['object', 'null'],
                properties: {
                  since: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
    handler: async () => listContainers(),
  });

  // ── Create ────────────────────────────────────────────────────────
  fastify.post('/containers', { config: { auth: 'admin' }, schema: { response: { 202: jobAckSchema } } }, async (request, reply) => {
    // Only the create contract's fields reach the manager: its spec also takes
    // env / mounts / devices / metadata, which app creation fills in itself.
    const { name, image, iconId, app, appConfig } = request.body && typeof request.body === 'object' ? request.body : {};
    const spec = { name, image, iconId, app, appConfig };
    if (!spec.name || !spec.image) {
      throw createAppError('VALIDATION_FAILED', 'body/name and body/image are required');
    }
    if (spec.app && !isKnownApp(spec.app)) {
      throw createAppError('UNKNOWN_APP_TYPE', `App "${spec.app}" is not a known app type`);
    }

    const newName = spec.name.trim();
    const job = await startJob({
      kind: BACKGROUND_JOB_KIND.CONTAINER_CREATE,
      title: titleForContainerCreate(newName),
      subject: { type: 'container', name: newName },
      check: () => assertContainerNameAvailable(spec.name), // a taken name is a 409 here, not a failed job
      log: request.log,
      run: async (report) => {
        await (spec.app ? createAppContainer(spec, report) : createContainer(spec, report));
        return { name: newName };
      },
    });
    return reply.code(202).send(job);
  });

  // ── OCI images (containerd) — before /containers/:name ────────────
  fastify.get('/containers/images', {
    config: { auth: 'read' },
    schema: {
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              digest: { type: 'string' },
              size: { type: 'number' },
              updated: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            },
          },
        },
      },
    },
    handler: async () => {
      return await listContainerImages();
    },
  });

  fastify.delete('/containers/images', {
    config: { auth: 'admin' },
    schema: {
      querystring: {
        type: 'object',
        required: ['ref'],
        properties: {
          ref: { type: 'string', minLength: 1 },
        },
      },
      response: { 202: jobAckSchema },
    },
    // A job: the delete waits for containerd's garbage collection. In use and
    // not found are answered here.
    handler: async (request, reply) => {
      const ref = request.query.ref;
      if (!ref || typeof ref !== 'string' || !ref.trim()) {
        throw createAppError('VALIDATION_FAILED', 'querystring/ref is required');
      }
      const imageName = await assertContainerImageDeletable(ref);
      const job = await startJob({
        kind: BACKGROUND_JOB_KIND.CONTAINER_IMAGE_DELETE,
        title: titleForContainerImageDelete(imageName),
        log: request.log,
        run: async () => {
          await deleteContainerImage(imageName);
          return { ref: imageName };
        },
      });
      return reply.code(202).send(job);
    },
  });

  // ── OCI image update check ────────────────────────────────────────
  // A shared job: a running check that covers this one is joined (every
  // image covers one image; one image never covers every image).
  fastify.post('/containers/images/check-updates', { config: { auth: 'admin' }, schema: { response: { 202: jobAckSchema } } }, async (request, reply) => {
    const ref = typeof request.body?.ref === 'string' && request.body.ref.trim()
      ? request.body.ref.trim()
      : null;
    // The check itself refreshes the image-meta sidecar and the list cache.
    return reply.code(202).send(await startImageUpdateCheckJob({ ref, log: request.log }));
  });

  fastify.get('/containers/images/update-status', { config: { auth: 'read' } }, async () => {
    return getImageUpdateStatus();
  });

  // ── Get single ────────────────────────────────────────────────────
  fastify.get('/containers/:name', { config: { auth: 'read' } }, async (request) => {
    return await maskContainerConfigSecrets(await getContainerConfig(request.params.name));
  });

  // ── Mount disk usage ──────────────────────────────────────────────
  // On-demand snapshot: sizes each mount's host-side bind source (sum of
  // file sizes). Can take seconds for large data directories.
  fastify.get('/containers/:name/mounts/usage', {
    config: { auth: 'read' },
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            mounts: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  containerPath: { type: 'string' },
                  type: { type: 'string' },
                  source: { type: 'string' },
                  hostPath: { type: ['string', 'null'] },
                  sizeBytes: { type: ['number', 'null'] },
                  partial: { type: 'boolean' },
                },
              },
            },
          },
        },
      },
    },
  }, async (request) => {
    return await getContainerMountUsage(request.params.name);
  });

  // ── Update ────────────────────────────────────────────────────────
  // PATCH may rename the container (when `name` differs from the URL segment).
  // In that case the rename runs first, and remaining fields are applied under
  // the new name. The response carries the name actually in effect so clients
  // can follow up with the new URL. The whole request holds the container's
  // operation lock — every branch writes container.json — and a rename also
  // holds the target name's, so nothing starts on it mid-move.
  fastify.patch('/containers/:name', { config: { auth: 'admin' } }, async (request, reply) => {
    const releaseLocks = [];
    try {
      const body = request.body && typeof request.body === 'object' ? request.body : {};
      const { name: requestedName, ...rest } = body;
      let workingName = request.params.name;
      // A body name is validated as sent, never trimmed or skipped when empty:
      // the name in effect is the one the client sent.
      if ('name' in body) validateContainerName(requestedName);
      const renameTo = 'name' in body && requestedName !== workingName ? requestedName : null;

      releaseLocks.push(acquireContainerOperationLock(workingName, renameTo ? 'rename' : 'configuration change'));
      if (renameTo) releaseLocks.push(acquireContainerOperationLock(renameTo, 'rename'));

      if (renameTo) {
        const oldName = workingName;
        const renamed = await renameContainer(workingName, renameTo);
        workingName = renamed.name;
        // Carry any custom-section assignment over to the new name so the
        // container keeps its sidebar section. Best-effort: assignments are
        // pure UI metadata, and the move reaches clients on the sections topic.
        try { await renameWorkloadAssignment('container', oldName, workingName); } catch { /* best effort */ }
        // mDNS A-record follows the rename: drop old name, register new. Best
        // effort — the reconciler will pick up the new name on the next event.
        try { await unpublishContainer(oldName); } catch { /* best effort */ }
        try { await publishContainer(workingName); } catch { /* best effort */ }
      }

      if (Object.keys(rest).length === 0) {
        return reply.code(204).send();
      }

      // Dispatch to containerApps for app-driven flows; everything else goes
      // through the generic manager. The manager itself has no app awareness.
      const config = await getContainerConfig(workingName);
      const isAppContainer = !!config?.metadata?.app;

      if (rest.eject === true) {
        if (isAppContainer) await ejectAppContainer(workingName);
        return reply.code(204).send();
      }

      if (isAppContainer && 'appConfig' in rest) {
        if ('env' in rest || 'envPatch' in rest || 'mounts' in rest || 'devices' in rest) {
          throw createAppError(
            'APP_CONFIG_ONLY',
            'Use appConfig to configure app containers, or eject to generic first',
          );
        }
        await applyAppConfig(workingName, rest.appConfig);
        return reply.code(204).send();
      }

      if (isAppContainer && ('env' in rest || 'envPatch' in rest || 'mounts' in rest)) {
        throw createAppError(
          'APP_CONFIG_ONLY',
          'Use appConfig to configure app containers, or eject to generic first',
        );
      }

      const { removedMounts } = await updateContainerConfig(workingName, rest);
      // A generic PATCH that drops a Local mount from `mounts` deletes its data —
      // the same contract as DELETE /mounts/:name. The manager only reports it;
      // deleting is this caller's explicit decision (app flows decide their own).
      for (const mountName of removedMounts) {
        await deleteRemovedMountData(workingName, mountName);
      }
      // Metadata-only flips don't fire a network-change event — call the
      // reconciler imperatively when localDns toggles. Same shape as the VM
      // PATCH handler in routes/vms.js.
      if ('localDns' in rest) {
        try {
          if (rest.localDns === false) await unpublishContainer(workingName);
          else if (rest.localDns === true) await publishContainer(workingName);
        } catch { /* best effort */ }
      }
      return reply.code(204).send();
    } finally {
      for (const release of releaseLocks) release();
    }
  });

  // ── Delete ────────────────────────────────────────────────────────
  // A job (stopping the task and removing the snapshot and files take a
  // while); a missing or busy container is answered here.
  fastify.delete('/containers/:name', { config: { auth: 'admin' }, schema: { response: { 202: jobAckSchema } } }, async (request, reply) => {
    const deleteFiles = request.query.deleteFiles !== 'false';
    const job = await startContainerDeleteJob({ name: request.params.name, deleteFiles, log: request.log });
    return reply.code(202).send(job);
  });

  // ── Lifecycle ─────────────────────────────────────────────────────
  // Start, stop and restart are jobs holding the per-container operation
  // lock; not found, busy and already running / not running are answered
  // here. Kill answers at once.
  for (const action of ['start', 'stop', 'restart']) {
    fastify.post(`/containers/:name/${action}`, { config: { auth: 'admin' }, schema: { response: { 202: jobAckSchema } } }, async (request, reply) => {
      const job = await startContainerLifecycleJob({ name: request.params.name, action, log: request.log });
      return reply.code(202).send(job);
    });
  }

  fastify.post('/containers/:name/kill', { config: { auth: 'admin' } }, async (request, reply) => {
    const { name } = request.params;
    await withContainerOperationLock(name, 'kill', () => killContainer(name));
    return reply.code(204).send();
  });

  // ── Backup ───────────────────────────────────────────────────────
  // Mirrors POST /vms/:name/backup. Works on running containers too — the
  // task is paused for the duration of the archive and resumed (enforced
  // inside createContainerBackup → freezeForBackup). Body shape:
  // { destinationIds: ["local"] | ["local", "<backupMountId>"] }.
  fastify.post('/containers/:name/backup', {
    config: { auth: 'admin' },
    schema: {
      body: {
        type: 'object',
        properties: {
          destinationIds: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
      response: {
        202: jobAckSchema,
      },
    },
    handler: async (request, reply) => {
      const { name } = request.params;
      const body = request.body || {};
      let destinations;
      // The operation lock keeps a second backup (its pause/resume around the
      // archive) and every other operation off the container for the whole job.
      const job = await startJob({
        kind: BACKGROUND_JOB_KIND.CONTAINER_BACKUP,
        title: titleForContainerBackup(name),
        subject: { type: 'container', name },
        check: async () => {
          await assertContainerState(name, 'exists');
          destinations = await resolveBackupDestinations(await getSettings(), await getRawMounts(), body.destinationIds);
        },
        log: request.log,
        run: async (report) => {
          const destinationIds = destinations.map((d) => d.id);
          let lastResult;
          try {
            lastResult = await backupToEachDestination(destinations, {
              push: report,
              backupOne: (dest, onProgress) => createContainerBackup(name, dest.path, { origin: 'manual', onProgress }),
            });
          } catch (err) {
            await recordBackupAttempt({
              kind: 'container', name, ok: false, origin: 'manual', destinationIds, error: err?.message,
            });
            throw err;
          }
          await recordBackupAttempt({
            kind: 'container', name, ok: true, origin: 'manual', destinationIds, timestamp: lastResult?.timestamp,
          });
          // The backup folder name only: its host path stays on the server.
          return { timestamp: lastResult?.timestamp };
        },
      });
      return reply.code(202).send(job);
    },
  });

  // ── Stats SSE ─────────────────────────────────────────────────────
  fastify.get('/containers/:name/stats', { config: { auth: 'read' } }, async (request, reply) => {
    const { name } = request.params;
    setupSSE(reply);
    const intervalMs = Math.max(2000, Math.min(60000, parseInt(request.query.intervalMs, 10) || 3000));

    const send = async () => {
      try {
        const config = await getContainerConfig(name);
        const stats = await getContainerStats(name);
        // `mdnsHostname` and `ip` both arrive *after* start — Avahi registration and the
        // CNI address land once the task is up — so they can't ride the container config
        // snapshot the client fetched when it selected the workload. getContainerConfig
        // re-reads them live on every tick (registered hostname from Avahi, IP from
        // container.json), which is exactly what this stream is for. Mirrors the VM stats
        // payload, which has carried `mdnsHostname`/`guestIp` all along.
        const payload = {
          ...stats,
          memoryLimitMiB: config.memoryLimitMiB || 0,
          mdnsHostname: config.mdnsHostname || null,
          ip: config.network?.ip || null,
        };
        reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch (err) {
        writeSSEError(reply.raw, err);
      }
    };

    await send();
    const timer = setInterval(send, intervalMs);
    onSSEClose(reply, () => clearInterval(timer));
  });

  // ── List runs ────────────────────────────────────────────────────
  fastify.get('/containers/:name/runs', { config: { auth: 'read' } }, async (request) => {
    const runs = await listContainerRuns(request.params.name);
    return { runs };
  });

  // ── Logs SSE ──────────────────────────────────────────────────────
  //
  // Streams history (tail) and live-appended lines for one run. `runId`
  // defaults to the newest run (ongoing one if any). Completed runs are read
  // from disk and tailed with no new output — still useful for filtering and
  // scrolling. Initial event: { type: "history", lines, runId }. Subsequent
  // events: { type: "line", line }. The tail starts at the byte offset the
  // history ended at, so every line arrives exactly once.
  fastify.get('/containers/:name/logs', { config: { auth: 'read' } }, async (request, reply) => {
    const { name } = request.params;
    const requestedRunId = typeof request.query.runId === 'string' ? request.query.runId : null;

    const runId = await resolveRunId(name, requestedRunId);

    setupSSE(reply);

    if (!runId) {
      reply.raw.write(`data: ${JSON.stringify({ type: 'history', lines: [], runId: null })}\n\n`);
      return;
    }

    let history;
    try {
      history = await readRunLogHistory(name, runId, 500);
    } catch (err) {
      writeSSEError(reply.raw, err);
      reply.raw.end();
      return;
    }
    reply.raw.write(`data: ${JSON.stringify({ type: 'history', lines: history.lines, runId })}\n\n`);

    const handle = streamContainerRunLogs(name, runId, history.offset, (line) => {
      try {
        reply.raw.write(`data: ${JSON.stringify({ type: 'line', line })}\n\n`);
      } catch { /* client disconnected */ }
    });

    onSSEClose(reply, () => handle.stop());
  });

  // ── Run log download ─────────────────────────────────────────────
  fastify.get('/containers/:name/runs/:runId/log', { config: { auth: 'read' } }, async (request, reply) => {
    const { name, runId: reqRunId } = request.params;
    if (!/^[a-zA-Z0-9._-]+$/.test(reqRunId)) {
      throw createAppError('VALIDATION_FAILED', 'params/runId must be alphanumeric (._- allowed)');
    }
    const runId = await resolveRunId(name, reqRunId);
    const filename = encodeURIComponent(`${name}-${runId}.log`);
    reply
      .header('Content-Type', 'text/plain; charset=utf-8')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
    return reply.send(createRunLogReadStream(name, runId));
  });

  // ── Mount definitions (row-scoped) ──────────────────────────────
  fastify.post('/containers/:name/mounts', { config: { auth: 'admin' } }, async (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== 'object') {
      throw createAppError('VALIDATION_FAILED', 'body must be an object with type, name, containerPath and readonly');
    }
    const { name } = request.params;
    await withContainerOperationLock(name, 'configuration change', async () => {
      assertMountListNotAppManaged(await getContainerConfig(name));
      return addContainerMount(name, body);
    });
    return reply.code(204).send();
  });

  fastify.patch('/containers/:name/mounts/:mountName', { config: { auth: 'admin' } }, async (request, reply) => {
    const { mountName } = request.params;
    const body = request.body && typeof request.body === 'object' ? request.body : {};
    const { name } = request.params;
    await withContainerOperationLock(name, 'configuration change', async () => {
      assertMountNotAppManaged(await getContainerConfig(name), mountName);
      return updateContainerMount(name, mountName, body);
    });
    return reply.code(204).send();
  });

  // A job: removing a Local mount deletes its data. Not found, app-managed
  // and busy are answered here; `done` is `{ requiresRestart }`.
  fastify.delete('/containers/:name/mounts/:mountName', { config: { auth: 'admin' }, schema: { response: { 202: jobAckSchema } } }, async (request, reply) => {
    const { mountName } = request.params;
    const { name } = request.params;
    const job = await startJob({
      kind: BACKGROUND_JOB_KIND.CONTAINER_MOUNT_DELETE,
      title: titleForContainerMountDelete(name, mountName),
      subject: { type: 'container', name },
      check: async () => {
        assertMountNotAppManaged(await getContainerConfig(name), mountName);
        await assertMountOperation(name, mountName, 'remove');
      },
      log: request.log,
      run: () => removeContainerMount(name, mountName),
    });
    return reply.code(202).send(job);
  });

  // ── Mount backing store (files/<mountName>) ───────────────────────
  // The file part streams into a temp file beside the mount's file and is
  // renamed over it once the whole body is read: the reply comes right after
  // the upload, the replace is atomic, and every rejection leaves the mount
  // as it was. The temp file goes on any failure (boot cleanup sweeps one a
  // crash leaves).
  fastify.post('/containers/:name/mounts/:mountName/file', { config: { auth: 'admin' } }, async (request, reply) => {
    const containerName = request.params.name;
    const bodyWatch = watchRequestBody(request);
    let plan = null;
    let committed = false;
    try {
      const { mountName } = request.params;
      assertMountNotAppManaged(await getContainerConfig(containerName), mountName);
      plan = await planMountFileUpload(containerName, mountName);
      if (!(await stageSingleMultipartFile(request, plan.tmp, { mode: plan.mode }))) {
        throw createAppError('UPLOAD_NO_FILE', 'The request must include a file upload');
      }
      bodyWatch.stop();
      await commitMountFileUpload(plan);
      committed = true;
      return reply.code(204).send();
    } finally {
      bodyWatch.stop();
      if (plan && !committed) await unlink(plan.tmp).catch(() => { /* never created, or already gone */ });
    }
  });

  // The upload is received here; the extract that follows is a job (202).
  // Not found, app-managed, a mount that takes no zip, an invalid or unsafe
  // archive and busy are answered here. The job owns the staged zip.
  fastify.post('/containers/:name/mounts/:mountName/zip', { config: { auth: 'admin' }, schema: { response: { 202: jobAckSchema } } }, async (request, reply) => {
    const containerName = request.params.name;
    const stagingPath = mountUploadStagingPath(containerName);
    const bodyWatch = watchRequestBody(request);
    let staged = true; // the finally removes it unless the job took it
    try {
      const { mountName } = request.params;
      // 404 / APP_CONFIG_ONLY / not a directory mount, before staging into the container dir.
      assertMountNotAppManaged(await getContainerConfig(containerName), mountName);
      await assertMountTakesZip(containerName, mountName);
      if (!(await stageSingleMultipartFile(request, stagingPath))) {
        throw createAppError('UPLOAD_NO_FILE', 'The request must include a zip upload');
      }
      bodyWatch.stop();
      // Checked again under the lock the job then holds, so no edit can move
      // the mount between the check and the extract.
      let plan;
      const job = await startJob({
        kind: BACKGROUND_JOB_KIND.CONTAINER_ZIP_EXTRACT,
        title: titleForZipExtract(containerName, mountName),
        subject: { type: 'container', name: containerName },
        check: async () => {
          assertMountNotAppManaged(await getContainerConfig(containerName), mountName);
          plan = await planMountZipExtract(containerName, mountName, stagingPath);
        },
        log: request.log,
        run: async () => {
          try {
            await extractMountZip(plan);
            return { name: containerName, mount: mountName };
          } finally {
            await unlink(stagingPath).catch(() => { /* already gone */ });
          }
        },
      });
      staged = false;
      return reply.code(202).send(job);
    } finally {
      bodyWatch.stop();
      if (staged) await unlink(stagingPath).catch(() => { /* never created, or already gone */ });
    }
  });

  fastify.get('/containers/:name/mounts/:mountName/content', { config: { auth: 'admin' } }, async (request) => {
    const { mountName } = request.params;
    assertMountContentReadable(await getContainerConfig(request.params.name), mountName);
    return await getMountFileTextContent(request.params.name, mountName);
  });

  // Per-route bodyLimit so a 50 MB JSON payload is rejected before reaching
  // the handler. The library's putMountFileTextContent does its own UTF-8
  // byte-length check at MOUNT_FILE_CONTENT_MAX_BYTES (512 KiB); the route
  // limit allows a small headroom for the JSON wrapper around `content`.
  const MOUNT_FILE_PUT_BODY_LIMIT = 600 * 1024;
  fastify.put('/containers/:name/mounts/:mountName/content', { bodyLimit: MOUNT_FILE_PUT_BODY_LIMIT, config: { auth: 'admin' }, ...bodyWatchHooks }, async (request, reply) => {
    const { mountName } = request.params;
    const body = request.body;
    const content = body && typeof body === 'object' && body !== null && 'content' in body
      ? body.content
      : undefined;
    if (typeof content !== 'string') {
      throw createAppError('VALIDATION_FAILED', 'body/content must be a string');
    }
    assertMountNotAppManaged(await getContainerConfig(request.params.name), mountName);
    await putMountFileTextContent(request.params.name, mountName, content);
    return reply.code(204).send();
  });

  fastify.post('/containers/:name/mounts/:mountName/init', { config: { auth: 'admin' } }, async (request, reply) => {
    const { mountName } = request.params;
    assertMountNotAppManaged(await getContainerConfig(request.params.name), mountName);
    await initMountContent(request.params.name, mountName);
    return reply.code(204).send();
  });

  // A job: a large data directory takes a while to delete. Not found,
  // app-managed, a tmpfs mount and busy are answered here.
  fastify.delete('/containers/:name/mounts/:mountName/data', { config: { auth: 'admin' }, schema: { response: { 202: jobAckSchema } } }, async (request, reply) => {
    const { mountName } = request.params;
    const { name } = request.params;
    const job = await startJob({
      kind: BACKGROUND_JOB_KIND.CONTAINER_MOUNT_DATA_DELETE,
      title: titleForContainerMountDataDelete(name, mountName),
      subject: { type: 'container', name },
      check: async () => {
        assertMountNotAppManaged(await getContainerConfig(name), mountName);
        await assertMountOperation(name, mountName, 'data');
      },
      log: request.log,
      run: async () => {
        await deleteMountData(name, mountName);
        return { name, mount: mountName };
      },
    });
    return reply.code(202).send(job);
  });

  // ── mDNS service advertisements (row-scoped, keyed by port) ─────
  fastify.post('/containers/:name/services', { config: { auth: 'admin' } }, async (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== 'object') {
      throw createAppError('VALIDATION_FAILED', 'body must be an object with port, type and an optional txt');
    }
    const { name } = request.params;
    await withContainerOperationLock(name, 'configuration change', () => addContainerService(name, body));
    return reply.code(204).send();
  });

  fastify.patch('/containers/:name/services/:port', { config: { auth: 'admin' } }, async (request, reply) => {
    const body = request.body && typeof request.body === 'object' ? request.body : {};
    const { name, port } = request.params;
    await withContainerOperationLock(name, 'configuration change', () => updateContainerService(name, port, body));
    return reply.code(204).send();
  });

  fastify.delete('/containers/:name/services/:port', { config: { auth: 'admin' } }, async (request, reply) => {
    const { name, port } = request.params;
    await withContainerOperationLock(name, 'configuration change', () => removeContainerService(name, port));
    return reply.code(204).send();
  });
}
