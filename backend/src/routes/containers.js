/**
 * Container API routes: CRUD, lifecycle, mount content, stats SSE, logs SSE.
 */
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

import {
  getContainerConfig, getContainerMountUsage,
  getContainerStats,
  listContainers,
  listContainerRuns, readRunLogHistory, streamContainerRunLogs, resolveRunId,
  createRunLogReadStream,
  getMountFileTextContent,
  listContainerImages, assertContainerImageDeletable, deleteContainerImage,
  getImageUpdateStatus,
} from '../lib/containerManager/index.js';
import {
  startJob,
  BACKGROUND_JOB_KIND,
  titleForContainerImageDelete,
} from '../lib/jobs/index.js';
import {
  startContainerCreateJob,
  startContainerStartJob,
  startContainerStopJob,
  startContainerRestartJob,
  killContainerNow,
  startContainerDeleteJob,
  startContainerBackupJob,
  editContainerConfig,
  saveContainerAppConfig,
  ejectContainerApp,
  addContainerMountRow,
  editContainerMountRow,
  startContainerMountDeleteJob,
  writeContainerMountFile,
  startContainerZipExtractJob,
  putContainerMountContent,
  initContainerMountContent,
  startContainerMountDataDeleteJob,
  addContainerServiceRow,
  editContainerServiceRow,
  removeContainerServiceRow,
} from '../lib/containerOperations.js';
import { startImageUpdateCheckJob } from '../lib/updateChecks.js';
import { watchRequestBody, bodyWatchHooks } from '../lib/requestBodyWatch.js';
import { onSSEClose, setupSSE, writeSSEError } from '../lib/sse.js';
import { createAppError } from '../lib/appErrors.js';
import { validateContainerName } from '../lib/validation.js';
import {
  isKnownApp,
  maskContainerConfigSecrets,
  assertMountContentReadable,
} from '../lib/containerApps/index.js';
import { jobAckSchema } from './schemas.js';

/**
 * Stream the request's single file part to `stagingPath` while iterating the
 * parts; a request without one answers UPLOAD_NO_FILE. The caller owns (and
 * always removes) the staging file.
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
async function stageSingleMultipartFile(request, stagingPath, { mode = 0o600, what = 'file' } = {}) {
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
  if (!staged) throw createAppError('UPLOAD_NO_FILE', `The request must include a ${what} upload`);
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

    const job = await startContainerCreateJob({ spec, log: request.log });
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
  // An app container's appConfig save goes to its app module, which
  // regenerates the env, mounts and files from it. Any other body is a
  // configuration update, a rename included (a body `name` other than the
  // URL's runs first, the rest applies under the new name).
  fastify.patch('/containers/:name', { config: { auth: 'admin' } }, async (request, reply) => {
    const body = request.body && typeof request.body === 'object' ? request.body : {};
    const { name } = request.params;
    if (body.eject === true) {
      await ejectContainerApp(name);
      return reply.code(204).send();
    }
    if ('appConfig' in body) {
      await saveContainerAppConfig(name, () => body.appConfig);
      return reply.code(204).send();
    }
    // A body name is validated as sent, never trimmed or skipped when empty:
    // the name in effect is the one the client sent.
    if ('name' in body) validateContainerName(body.name);
    await editContainerConfig({ name, changes: body, log: request.log });
    return reply.code(204).send();
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
  // Start, stop and restart are jobs; not found, busy and already running /
  // not running are answered here. Kill answers at once.
  const lifecycleJobs = [
    { path: 'start', start: startContainerStartJob },
    { path: 'stop', start: startContainerStopJob },
    { path: 'restart', start: startContainerRestartJob },
  ];
  for (const { path, start } of lifecycleJobs) {
    fastify.post(`/containers/:name/${path}`, { config: { auth: 'admin' }, schema: { response: { 202: jobAckSchema } } }, async (request, reply) => {
      const job = await start({ name: request.params.name, log: request.log });
      return reply.code(202).send(job);
    });
  }

  fastify.post('/containers/:name/kill', { config: { auth: 'admin' } }, async (request, reply) => {
    await killContainerNow(request.params.name);
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
      const job = await startContainerBackupJob({
        name: request.params.name, origin: 'manual', destinationIds: request.body?.destinationIds, log: request.log,
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
    await addContainerMountRow(request.params.name, body);
    return reply.code(204).send();
  });

  fastify.patch('/containers/:name/mounts/:mountName', { config: { auth: 'admin' } }, async (request, reply) => {
    const body = request.body && typeof request.body === 'object' ? request.body : {};
    await editContainerMountRow(request.params.name, request.params.mountName, body);
    return reply.code(204).send();
  });

  // A job: removing a Local mount deletes its data. Not found, app-managed
  // and busy are answered here; `done` is `{ requiresRestart }`.
  fastify.delete('/containers/:name/mounts/:mountName', { config: { auth: 'admin' }, schema: { response: { 202: jobAckSchema } } }, async (request, reply) => {
    const { name, mountName } = request.params;
    const job = await startContainerMountDeleteJob({ name, mountName, log: request.log });
    return reply.code(202).send(job);
  });

  // ── Mount backing store (files/<mountName>) ───────────────────────
  // The file part streams into a temp file beside the mount's file, renamed
  // over it once the whole body is read (lib/containerOperations.js): the
  // reply comes right after the upload, and every rejection leaves the mount
  // as it was.
  fastify.post('/containers/:name/mounts/:mountName/file', { config: { auth: 'admin' } }, async (request, reply) => {
    const { name, mountName } = request.params;
    const bodyWatch = watchRequestBody(request);
    try {
      await writeContainerMountFile({
        name,
        mountName,
        stage: async (tmpPath, mode) => {
          await stageSingleMultipartFile(request, tmpPath, { mode });
          bodyWatch.stop();
        },
      });
      return reply.code(204).send();
    } finally {
      bodyWatch.stop();
    }
  });

  // The upload is received here; the extract that follows is a job (202).
  // Not found, app-managed, a mount that takes no zip, an invalid or unsafe
  // archive and busy are answered here.
  fastify.post('/containers/:name/mounts/:mountName/zip', { config: { auth: 'admin' }, schema: { response: { 202: jobAckSchema } } }, async (request, reply) => {
    const { name, mountName } = request.params;
    const bodyWatch = watchRequestBody(request);
    try {
      const job = await startContainerZipExtractJob({
        name,
        mountName,
        stage: async (stagingPath) => {
          await stageSingleMultipartFile(request, stagingPath, { what: 'zip' });
          bodyWatch.stop();
        },
        log: request.log,
      });
      return reply.code(202).send(job);
    } finally {
      bodyWatch.stop();
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
    await putContainerMountContent(request.params.name, mountName, content);
    return reply.code(204).send();
  });

  fastify.post('/containers/:name/mounts/:mountName/init', { config: { auth: 'admin' } }, async (request, reply) => {
    await initContainerMountContent(request.params.name, request.params.mountName);
    return reply.code(204).send();
  });

  // A job: a large data directory takes a while to delete. Not found,
  // app-managed, a tmpfs mount and busy are answered here.
  fastify.delete('/containers/:name/mounts/:mountName/data', { config: { auth: 'admin' }, schema: { response: { 202: jobAckSchema } } }, async (request, reply) => {
    const { name, mountName } = request.params;
    const job = await startContainerMountDataDeleteJob({ name, mountName, log: request.log });
    return reply.code(202).send(job);
  });

  // ── mDNS service advertisements (row-scoped, keyed by port) ─────
  fastify.post('/containers/:name/services', { config: { auth: 'admin' } }, async (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== 'object') {
      throw createAppError('VALIDATION_FAILED', 'body must be an object with port, type and an optional txt');
    }
    await addContainerServiceRow(request.params.name, body);
    return reply.code(204).send();
  });

  fastify.patch('/containers/:name/services/:port', { config: { auth: 'admin' } }, async (request, reply) => {
    const body = request.body && typeof request.body === 'object' ? request.body : {};
    const { name, port } = request.params;
    await editContainerServiceRow(name, port, body);
    return reply.code(204).send();
  });

  fastify.delete('/containers/:name/services/:port', { config: { auth: 'admin' } }, async (request, reply) => {
    const { name, port } = request.params;
    await removeContainerServiceRow(name, port);
    return reply.code(204).send();
  });
}
