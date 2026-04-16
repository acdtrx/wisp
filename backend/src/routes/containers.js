/**
 * Container API routes: CRUD, lifecycle, mount content, stats SSE, logs SSE, create progress SSE.
 */
import { randomUUID } from 'node:crypto';

import {
  listContainers, getContainerConfig, createContainer, deleteContainer,
  startContainer, stopContainer, killContainer, restartContainer,
  updateContainerConfig, addContainerMount, updateContainerMount, removeContainerMount,
  getContainerStats, getContainerLogs, streamContainerLogs,
  uploadMountFileStream, uploadMountZipStream, initMountContent, deleteMountData,
  getMountFileTextContent, putMountFileTextContent,
  listContainerImages, deleteContainerImage,
} from '../lib/containerManager.js';
import { containerJobStore } from '../lib/containerJobStore.js';
import { BACKGROUND_JOB_KIND } from '../lib/backgroundJobKinds.js';
import { titleForContainerCreate } from '../lib/backgroundJobTitles.js';
import { setupSSE } from '../lib/sse.js';
import { createAppError, handleRouteError, sendError } from '../lib/routeErrors.js';
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
  // ── List ──────────────────────────────────────────────────────────
  fastify.get('/containers', async () => {
    return listContainers();
  });

  // ── List SSE stream ───────────────────────────────────────────────
  fastify.get('/containers/stream', async (request, reply) => {
    setupSSE(reply);
    const intervalMs = Math.max(2000, Math.min(60000, parseInt(request.query.intervalMs, 10) || 5000));

    const send = async () => {
      try {
        const list = await listContainers();
        reply.raw.write(`data: ${JSON.stringify(list)}\n\n`);
      } catch { /* skip tick */ }
    };

    await send();
    const timer = setInterval(send, intervalMs);
    request.raw.on('close', () => clearInterval(timer));
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

  // ── Get single ────────────────────────────────────────────────────
  fastify.get('/containers/:name', async (request, reply) => {
    try {
      return maskContainerSecrets(await getContainerConfig(request.params.name));
    } catch (err) {
      handleRouteError(err, reply, request);
    }
  });

  // ── Update ────────────────────────────────────────────────────────
  fastify.patch('/containers/:name', async (request, reply) => {
    try {
      return await updateContainerConfig(request.params.name, request.body);
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

  // ── Logs SSE ──────────────────────────────────────────────────────
  fastify.get('/containers/:name/logs', async (request, reply) => {
    const { name } = request.params;
    const scope = request.query.scope === 'all' ? 'all' : 'session';
    setupSSE(reply);

    // Send existing logs first
    try {
      let fromBytes = 0;
      if (scope === 'session') {
        const cfg = await getContainerConfig(name);
        const b = cfg.sessionLogStartBytes;
        fromBytes = typeof b === 'number' && Number.isFinite(b) && b >= 0 ? b : 0;
      }
      const { lines } = await getContainerLogs(name, 500, { fromBytes });
      if (lines.length) {
        reply.raw.write(`data: ${JSON.stringify({ type: 'history', lines })}\n\n`);
      }
    } catch { /* no logs yet */ }

    // Stream new lines
    const handle = streamContainerLogs(name, (line) => {
      try {
        reply.raw.write(`data: ${JSON.stringify({ type: 'line', line })}\n\n`);
      } catch { /* client disconnected */ }
    });

    request.raw.on('close', () => handle.stop());
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

  fastify.put('/containers/:name/mounts/:mountName/content', async (request, reply) => {
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
}
