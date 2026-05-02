/**
 * Container API routes: CRUD, lifecycle, mount content, stats SSE, logs SSE, create progress SSE.
 */
import { randomUUID } from 'node:crypto';

import {
  listContainers, getContainerConfig, createContainer, deleteContainer, renameContainer,
  startContainer, stopContainer, killContainer, restartContainer,
  updateContainerConfig, addContainerMount, updateContainerMount, removeContainerMount,
  addContainerService, updateContainerService, removeContainerService,
  getContainerStats,
  listContainerRuns, getContainerRunLogs, streamContainerRunLogs, resolveRunId,
  createRunLogReadStream,
  uploadMountFileStream, uploadMountZipStream, initMountContent, deleteMountData,
  getMountFileTextContent, putMountFileTextContent,
  listContainerImages, deleteContainerImage,
  checkAllImagesForUpdates, checkSingleImageForUpdates, getImageUpdateStatus,
  subscribeContainerListChange, notifyContainerConfigWrite,
} from '../lib/containerManager.js';
import { containerJobStore } from '../lib/containerJobStore.js';
import { imageUpdateJobStore } from '../lib/imageUpdateJobStore.js';
import { BACKGROUND_JOB_KIND } from '../lib/backgroundJobKinds.js';
import {
  titleForContainerCreate,
  TITLE_IMAGE_UPDATE_CHECK_ALL,
  titleForImageUpdateCheckSingle,
} from '../lib/backgroundJobTitles.js';
import { setupSSE } from '../lib/sse.js';
import { createAppError, handleRouteError, sendError } from '../lib/routeErrors.js';
import { validateContainerName } from '../lib/validation.js';
import { isKnownApp, getAppModule } from '../lib/linux/containerManager/apps/appRegistry.js';

function maskContainerSecrets(config) {
  if (!config || !config.env || typeof config.env !== 'object') return config;
  const env = {};
  for (const [k, v] of Object.entries(config.env)) {
    if (v?.secret) {
      env[k] = {
        value: null,
        secret: true,
        isSet: typeof v.value === 'string' && v.value.length > 0,
      };
    } else {
      env[k] = { value: v?.value ?? '' };
    }
  }
  const masked = { ...config, env };

  // Mask app-specific secrets
  if (masked.app && masked.appConfig) {
    const appModule = getAppModule(masked.app);
    if (appModule?.maskSecrets) {
      masked.appConfig = appModule.maskSecrets(masked.appConfig);
    }
  }

  return masked;
}

/**
 * @returns {import('@fastify/multipart').MultipartFile | null}
 */
async function collectSingleMultipartFile(request) {
  /** @type {import('@fastify/multipart').MultipartFile | null} */
  let filePart = null;
  for await (const part of request.parts()) {
    if (part.type === 'file') {
      if (filePart) {
        throw createAppError(
          'BAD_MULTIPART_TOO_MANY_FILES',
          'Only one file upload is allowed per request',
        );
      }
      filePart = part;
    }
  }
  return filePart;
}

export default async function containerRoutes(fastify) {
  fastify.addHook('preHandler', async (request, reply) => {
    const name = request.params?.name;
    if (name === undefined) return;
    try {
      validateContainerName(name);
    } catch (err) {
      handleRouteError(err, reply, request);
    }
  });

  // ── List ──────────────────────────────────────────────────────────
  fastify.get('/containers', {
    schema: {
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string' },
              image: { type: 'string' },
              state: { type: 'string' },
              iconId: { type: ['string', 'null'] },
              updateAvailable: { type: 'boolean' },
            },
          },
        },
      },
    },
    handler: async () => listContainers(),
  });

  // ── List SSE stream ───────────────────────────────────────────────
  // Event-driven: pushes on containerd events (tasks/containers create/start/exit/etc.),
  // container.json writes, and image-update completion. No polling timer.
  // Section assignment is *not* part of this payload — the frontend reads
  // sections via /api/sections (mirrored into sectionsStore) because moving
  // a workload between sections doesn't trigger a containerd event.
  fastify.get('/containers/stream', async (request, reply) => {
    setupSSE(reply);

    const send = async () => {
      try {
        const list = await listContainers();
        reply.raw.write(`data: ${JSON.stringify(list)}\n\n`);
      } catch (err) {
        const payload = { error: 'Failed to list containers', detail: err.raw || err.message, code: err.code };
        try { reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`); }
        catch { /* client gone */ }
      }
    };

    await send();
    const unsubscribe = subscribeContainerListChange(() => { send(); });
    request.raw.on('close', () => unsubscribe());
  });

  // ── Create ────────────────────────────────────────────────────────
  fastify.post('/containers', async (request, reply) => {
    const spec = request.body;
    if (!spec?.name || !spec?.image) {
      return sendError(reply, 422, 'Missing required fields', 'name and image are required');
    }
    if (spec.app && !isKnownApp(spec.app)) {
      return sendError(reply, 422, 'Unknown app type', `App "${spec.app}" is not a known app type`);
    }

    const jobId = randomUUID();
    const title = titleForContainerCreate(spec.name.trim());
    containerJobStore.createJob(jobId, {
      kind: BACKGROUND_JOB_KIND.CONTAINER_CREATE,
      title,
      log: request.log,
    });
    request.log.info(
      { jobId, kind: BACKGROUND_JOB_KIND.CONTAINER_CREATE, title },
      'Background job started',
    );

    createContainer(spec, (ev) => containerJobStore.pushEvent(jobId, ev))
      .then((result) => containerJobStore.completeJob(jobId, result))
      .catch((err) => containerJobStore.failJob(jobId, err));

    return { jobId, title };
  });

  // ── Create progress SSE ───────────────────────────────────────────
  fastify.get('/containers/create-progress/:jobId', async (request, reply) => {
    const { jobId } = request.params;
    const job = containerJobStore.getJob(jobId);
    if (!job) return sendError(reply, 404, 'Job not found', `No job with id "${jobId}"`);

    setupSSE(reply);
    containerJobStore.registerStream(jobId, reply.raw);
    request.raw.on('close', () => containerJobStore.unregisterStream(jobId, reply.raw));
  });

  // ── OCI images (containerd) — before /containers/:name ────────────
  fastify.get('/containers/images', {
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
    handler: async (request, reply) => {
      try {
        return await listContainerImages();
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  fastify.delete('/containers/images', {
    schema: {
      querystring: {
        type: 'object',
        required: ['ref'],
        properties: {
          ref: { type: 'string', minLength: 1 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
        },
      },
    },
    handler: async (request, reply) => {
      const ref = request.query.ref;
      if (!ref || typeof ref !== 'string' || !ref.trim()) {
        return sendError(reply, 422, 'Missing image reference', 'ref query parameter is required');
      }
      try {
        await deleteContainerImage(ref);
        return { ok: true };
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  // ── OCI image update check ────────────────────────────────────────
  fastify.post('/containers/images/check-updates', async (request, reply) => {
    const ref = typeof request.body?.ref === 'string' && request.body.ref.trim()
      ? request.body.ref.trim()
      : null;

    const jobId = randomUUID();
    const title = ref ? titleForImageUpdateCheckSingle(ref) : TITLE_IMAGE_UPDATE_CHECK_ALL;
    imageUpdateJobStore.createJob(jobId, {
      kind: BACKGROUND_JOB_KIND.CONTAINER_IMAGE_UPDATE_CHECK,
      title,
      log: request.log,
    });
    request.log.info(
      { jobId, kind: BACKGROUND_JOB_KIND.CONTAINER_IMAGE_UPDATE_CHECK, title, ref: ref || 'all' },
      'Background job started',
    );

    const runner = ref
      ? checkSingleImageForUpdates(ref, (ev) => imageUpdateJobStore.pushEvent(jobId, ev))
      : checkAllImagesForUpdates((ev) => imageUpdateJobStore.pushEvent(jobId, ev));

    runner
      .then(async (result) => {
        imageUpdateJobStore.completeJob(jobId, result);
        // Refresh the image-meta sidecar so deriveUpdateAvailable sees the new
        // library digests, then notify so the container list cache recomputes.
        try { await listContainerImages(); } catch { /* best-effort */ }
        notifyContainerConfigWrite('*');
      })
      .catch((err) => imageUpdateJobStore.failJob(jobId, err));

    return { jobId, title };
  });

  fastify.get('/containers/images/check-updates/:jobId', async (request, reply) => {
    const { jobId } = request.params;
    const job = imageUpdateJobStore.getJob(jobId);
    if (!job) return sendError(reply, 404, 'Job not found', `No job with id "${jobId}"`);

    setupSSE(reply);
    imageUpdateJobStore.registerStream(jobId, reply.raw);
    request.raw.on('close', () => imageUpdateJobStore.unregisterStream(jobId, reply.raw));
  });

  fastify.get('/containers/images/update-status', async () => {
    return getImageUpdateStatus();
  });

  // ── Get single ────────────────────────────────────────────────────
  fastify.get('/containers/:name', async (request, reply) => {
    try {
      return maskContainerSecrets(await getContainerConfig(request.params.name));
    } catch (err) {
      handleRouteError(err, reply, request);
    }
  });

  // ── Update ────────────────────────────────────────────────────────
  // PATCH may rename the container (when `name` differs from the URL segment).
  // In that case the rename runs first, and remaining fields are applied under
  // the new name. The response carries the name actually in effect so clients
  // can follow up with the new URL.
  fastify.patch('/containers/:name', async (request, reply) => {
    try {
      const body = request.body && typeof request.body === 'object' ? request.body : {};
      const { name: requestedName, ...rest } = body;
      let workingName = request.params.name;

      if (typeof requestedName === 'string' && requestedName.trim()
        && requestedName.trim() !== workingName) {
        const renamed = await renameContainer(workingName, requestedName.trim());
        workingName = renamed.name;
      }

      if (Object.keys(rest).length === 0) {
        return { ok: true, name: workingName };
      }
      const result = await updateContainerConfig(workingName, rest);
      return { ...result, name: workingName };
    } catch (err) {
      handleRouteError(err, reply, request);
    }
  });

  // ── Delete ────────────────────────────────────────────────────────
  fastify.delete('/containers/:name', async (request, reply) => {
    try {
      const deleteFiles = request.query.deleteFiles !== 'false';
      await deleteContainer(request.params.name, deleteFiles);
      return { ok: true };
    } catch (err) {
      handleRouteError(err, reply, request);
    }
  });

  // ── Lifecycle ─────────────────────────────────────────────────────
  fastify.post('/containers/:name/start', async (request, reply) => {
    try {
      await startContainer(request.params.name);
      return { ok: true };
    } catch (err) {
      handleRouteError(err, reply, request);
    }
  });

  fastify.post('/containers/:name/stop', async (request, reply) => {
    try {
      await stopContainer(request.params.name);
      return { ok: true };
    } catch (err) {
      handleRouteError(err, reply, request);
    }
  });

  fastify.post('/containers/:name/restart', async (request, reply) => {
    try {
      await restartContainer(request.params.name);
      return { ok: true };
    } catch (err) {
      handleRouteError(err, reply, request);
    }
  });

  fastify.post('/containers/:name/kill', async (request, reply) => {
    try {
      await killContainer(request.params.name);
      return { ok: true };
    } catch (err) {
      handleRouteError(err, reply, request);
    }
  });

  // ── Stats SSE ─────────────────────────────────────────────────────
  fastify.get('/containers/:name/stats', async (request, reply) => {
    const { name } = request.params;
    setupSSE(reply);
    const intervalMs = Math.max(2000, Math.min(60000, parseInt(request.query.intervalMs, 10) || 3000));

    const send = async () => {
      try {
        const config = await getContainerConfig(name);
        const stats = await getContainerStats(name);
        const payload = {
          ...stats,
          memoryLimitMiB: config.memoryLimitMiB || 0,
        };
        reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch (err) {
        const code = err.code || 'CONTAINERD_ERROR';
        const detail = err.raw || err.message || String(err);
        reply.raw.write(
          `data: ${JSON.stringify({
            error: err.message || 'Error',
            detail,
            code,
          })}\n\n`,
        );
      }
    };

    await send();
    const timer = setInterval(send, intervalMs);
    request.raw.on('close', () => clearInterval(timer));
  });

  // ── List runs ────────────────────────────────────────────────────
  fastify.get('/containers/:name/runs', async (request, reply) => {
    try {
      const runs = await listContainerRuns(request.params.name);
      return { runs };
    } catch (err) {
      handleRouteError(err, reply, request);
    }
  });

  // ── Logs SSE ──────────────────────────────────────────────────────
  //
  // Streams history (tail) and live-appended lines for one run. `runId`
  // defaults to the newest run (ongoing one if any). Completed runs are read
  // from disk and tailed with no new output — still useful for filtering and
  // scrolling. Initial event: { type: "history", lines, runId }. Subsequent
  // events: { type: "line", line }.
  fastify.get('/containers/:name/logs', async (request, reply) => {
    const { name } = request.params;
    const requestedRunId = typeof request.query.runId === 'string' ? request.query.runId : null;

    let runId;
    try {
      runId = await resolveRunId(name, requestedRunId);
    } catch (err) {
      handleRouteError(err, reply, request);
      return;
    }

    setupSSE(reply);

    if (!runId) {
      reply.raw.write(`data: ${JSON.stringify({ type: 'history', lines: [], runId: null })}\n\n`);
      request.raw.on('close', () => {});
      return;
    }

    try {
      const { lines } = await getContainerRunLogs(name, runId, 500);
      reply.raw.write(`data: ${JSON.stringify({ type: 'history', lines, runId })}\n\n`);
    } catch { /* history unavailable — proceed to tail */ }

    const handle = streamContainerRunLogs(name, runId, (line) => {
      try {
        reply.raw.write(`data: ${JSON.stringify({ type: 'line', line })}\n\n`);
      } catch { /* client disconnected */ }
    });

    request.raw.on('close', () => handle.stop());
  });

  // ── Run log download ─────────────────────────────────────────────
  fastify.get('/containers/:name/runs/:runId/log', async (request, reply) => {
    const { name, runId: reqRunId } = request.params;
    if (!/^[a-zA-Z0-9._-]+$/.test(reqRunId)) {
      return sendError(reply, 422, 'Invalid run id', 'runId must be alphanumeric (._- allowed)');
    }
    try {
      const runId = await resolveRunId(name, reqRunId);
      if (!runId) {
        return sendError(reply, 404, 'Run not found', `No run "${reqRunId}" for "${name}"`);
      }
      const filename = encodeURIComponent(`${name}-${runId}.log`);
      reply
        .header('Content-Type', 'text/plain; charset=utf-8')
        .header('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
      return reply.send(createRunLogReadStream(name, runId));
    } catch (err) {
      handleRouteError(err, reply, request);
    }
  });

  // ── Mount definitions (row-scoped) ──────────────────────────────
  fastify.post('/containers/:name/mounts', async (request, reply) => {
    try {
      const body = request.body;
      if (!body || typeof body !== 'object') {
        return sendError(reply, 422, 'Invalid body', 'Expected JSON object with type, name, containerPath, readonly');
      }
      return await addContainerMount(request.params.name, body);
    } catch (err) {
      handleRouteError(err, reply, request);
    }
  });

  fastify.patch('/containers/:name/mounts/:mountName', async (request, reply) => {
    try {
      const mountName = decodeURIComponent(request.params.mountName);
      const body = request.body && typeof request.body === 'object' ? request.body : {};
      return await updateContainerMount(request.params.name, mountName, body);
    } catch (err) {
      handleRouteError(err, reply, request);
    }
  });

  fastify.delete('/containers/:name/mounts/:mountName', async (request, reply) => {
    try {
      const mountName = decodeURIComponent(request.params.mountName);
      return await removeContainerMount(request.params.name, mountName);
    } catch (err) {
      handleRouteError(err, reply, request);
    }
  });

  // ── Mount backing store (files/<mountName>) ───────────────────────
  fastify.post('/containers/:name/mounts/:mountName/file', async (request, reply) => {
    try {
      const containerName = request.params.name;
      const mountName = decodeURIComponent(request.params.mountName);
      const filePart = await collectSingleMultipartFile(request);
      if (!filePart) {
        return sendError(reply, 400, 'No file provided', 'Request must include a file upload');
      }
      return await uploadMountFileStream(containerName, mountName, filePart.file);
    } catch (err) {
      handleRouteError(err, reply, request);
    }
  });

  fastify.post('/containers/:name/mounts/:mountName/zip', async (request, reply) => {
    try {
      const containerName = request.params.name;
      const mountName = decodeURIComponent(request.params.mountName);
      const filePart = await collectSingleMultipartFile(request);
      if (!filePart) {
        return sendError(reply, 400, 'No file provided', 'Request must include a zip upload');
      }
      return await uploadMountZipStream(containerName, mountName, filePart.file);
    } catch (err) {
      handleRouteError(err, reply, request);
    }
  });

  fastify.get('/containers/:name/mounts/:mountName/content', async (request, reply) => {
    try {
      const mountName = decodeURIComponent(request.params.mountName);
      return await getMountFileTextContent(request.params.name, mountName);
    } catch (err) {
      handleRouteError(err, reply, request);
    }
  });

  // Per-route bodyLimit so a 50 MB JSON payload is rejected before reaching
  // the handler. The library's putMountFileTextContent does its own UTF-8
  // byte-length check at MOUNT_FILE_CONTENT_MAX_BYTES (512 KiB); the route
  // limit allows a small headroom for the JSON wrapper around `content`.
  const MOUNT_FILE_PUT_BODY_LIMIT = 600 * 1024;
  fastify.put('/containers/:name/mounts/:mountName/content', { bodyLimit: MOUNT_FILE_PUT_BODY_LIMIT }, async (request, reply) => {
    try {
      const mountName = decodeURIComponent(request.params.mountName);
      const body = request.body;
      const content = body && typeof body === 'object' && body !== null && 'content' in body
        ? body.content
        : undefined;
      if (typeof content !== 'string') {
        return sendError(reply, 400, 'Invalid body', 'Expected JSON object { "content": string }');
      }
      return await putMountFileTextContent(request.params.name, mountName, content);
    } catch (err) {
      handleRouteError(err, reply, request);
    }
  });

  fastify.post('/containers/:name/mounts/:mountName/init', async (request, reply) => {
    try {
      const mountName = decodeURIComponent(request.params.mountName);
      return await initMountContent(request.params.name, mountName);
    } catch (err) {
      handleRouteError(err, reply, request);
    }
  });

  fastify.delete('/containers/:name/mounts/:mountName/data', async (request, reply) => {
    try {
      const mountName = decodeURIComponent(request.params.mountName);
      await deleteMountData(request.params.name, mountName);
      return { ok: true };
    } catch (err) {
      handleRouteError(err, reply, request);
    }
  });

  // ── mDNS service advertisements (row-scoped, keyed by port) ─────
  fastify.post('/containers/:name/services', async (request, reply) => {
    try {
      const body = request.body;
      if (!body || typeof body !== 'object') {
        return sendError(reply, 422, 'Invalid body', 'Expected JSON object with port, type, txt?');
      }
      return await addContainerService(request.params.name, body);
    } catch (err) {
      handleRouteError(err, reply, request);
    }
  });

  fastify.patch('/containers/:name/services/:port', async (request, reply) => {
    try {
      const body = request.body && typeof request.body === 'object' ? request.body : {};
      return await updateContainerService(request.params.name, request.params.port, body);
    } catch (err) {
      handleRouteError(err, reply, request);
    }
  });

  fastify.delete('/containers/:name/services/:port', async (request, reply) => {
    try {
      return await removeContainerService(request.params.name, request.params.port);
    } catch (err) {
      handleRouteError(err, reply, request);
    }
  });
}
