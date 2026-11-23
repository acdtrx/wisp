/**
 * Container API routes: the list and the detail, every command on a container
 * (each one an operation of lib/containerOperations.js), mounts, services,
 * run logs, images and the stats and logs streams.
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
import { openOnPurpose } from '../lib/schemaValidation.js';
import { containerBridgeSchema, containerNameSchema } from '../lib/validation.js';
import {
  isKnownApp,
  maskContainerConfigSecrets,
  assertMountContentReadable,
} from '../lib/containerApps/index.js';
import {
  backupBodySchema, containerParamsSchema, jobAckSchema, noContentSchema, runIdSchema,
} from './schemas.js';
import { JOB_KIND } from '../../../shared/wireNames.js';

/* ── Schemas ──────────────────────────────────────────────────────────── */

const nameParams = containerParamsSchema();
const mountParams = containerParamsSchema({ mountName: { type: 'string', minLength: 1 } });
const servicePortSchema = { type: 'integer', minimum: 1, maximum: 65535 };
const serviceParams = containerParamsSchema({ port: servicePortSchema });

const restartPolicySchema = { type: 'string', enum: ['never', 'on-failure', 'unless-stopped', 'always'] };
const iconIdSchema = { type: ['string', 'null'] };
/** An app's own configuration: its app module validates it (docs/specs/CUSTOM-APPS.md). */
const appConfigSchema = openOnPurpose({ type: 'object' });

/** A mount entry: the name is a path segment and the semantic rules are the manager's (CONTAINERS.md, Mount entry). */
const mountFields = {
  type: { type: 'string', enum: ['file', 'directory', 'tmpfs'] },
  name: { type: 'string', minLength: 1 },
  containerPath: { type: 'string', minLength: 1 },
  readonly: { type: 'boolean' },
  sourceId: { type: ['string', 'null'] },
  subPath: { type: 'string' },
  containerOwnerUid: { type: 'integer', minimum: 0, maximum: 65535 },
  containerOwnerGid: { type: 'integer', minimum: 0, maximum: 65535 },
  sizeMiB: { type: 'integer', minimum: 1 },
  secret: { type: 'boolean' },
};
const mountBodySchema = {
  type: 'object',
  required: ['type', 'name', 'containerPath'],
  properties: mountFields,
  additionalProperties: false,
};

/** An mDNS service's TXT records: any key, a string each. */
const serviceTxtSchema = openOnPurpose({ type: 'object', additionalProperties: { type: 'string' } });

/** One entry of an env delta: an upsert (`{ value?, secret? }`) or `null`, a removal. */
const envPatchEntrySchema = {
  type: ['object', 'null'],
  properties: {
    value: { type: 'string' },
    secret: { type: 'boolean' },
  },
  additionalProperties: false,
};

/**
 * A container configuration update (API-CONTAINERS.md, PATCH): each field the
 * container's record takes from a client. An `appConfig` save stands alone;
 * environment variables change through `envPatch` only.
 */
const containerPatchSchema = {
  type: 'object',
  properties: {
    name: containerNameSchema,
    image: { type: 'string', minLength: 1 },
    command: { type: ['array', 'null'], items: { type: 'string' } },
    cpuLimit: { type: ['number', 'null'], exclusiveMinimum: 0 },
    memoryLimitMiB: { type: ['integer', 'null'], minimum: 1 },
    restartPolicy: restartPolicySchema,
    autostart: { type: 'boolean' },
    autoBackup: { type: 'boolean' },
    runAsRoot: { type: 'boolean' },
    localDns: { type: 'boolean' },
    iconId: iconIdSchema,
    network: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['bridge'] },
        mac: { type: 'string' },
        interface: containerBridgeSchema,
      },
      additionalProperties: false,
    },
    envPatch: openOnPurpose({ type: 'object', additionalProperties: envPatchEntrySchema }),
    mounts: { type: 'array', items: mountBodySchema },
    mountRenames: openOnPurpose({ type: 'object', additionalProperties: { type: 'string', minLength: 1 } }),
    devices: {
      type: 'array',
      items: {
        type: 'object',
        required: ['type', 'device'],
        properties: {
          type: { type: 'string', enum: ['gpu'] },
          device: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
    appConfig: appConfigSchema,
  },
  additionalProperties: false,
};

/** GET /containers rows: what the sidebar and the Backups panel render. */
const containerListItemSchema = {
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
      properties: { attempt: { type: 'integer' }, at: { type: 'number' } },
      additionalProperties: false,
    },
    pendingRestart: {
      type: ['object', 'null'],
      properties: { since: { type: 'string' } },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

/**
 * GET /containers/:name: the container's record with its secrets masked
 * (env values and secret file mounts), plus its live state.
 */
const containerDetailSchema = {
  type: 'object',
  properties: {
    ...containerListItemSchema.properties,
    command: { type: ['array', 'null'], items: { type: 'string' } },
    exposedPorts: { type: 'array', items: { type: 'string' } },
    cpuLimit: { type: ['number', 'null'] },
    memoryLimitMiB: { type: ['number', 'null'] },
    restartPolicy: { type: 'string' },
    autostart: { type: 'boolean' },
    localDns: { type: 'boolean' },
    runAsRoot: { type: 'boolean' },
    createdAt: { type: 'string' },
    imageDigest: { type: 'string' },
    imagePulledAt: { type: 'string' },
    env: openOnPurpose({
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: {
          value: { type: ['string', 'null'] },
          secret: { type: 'boolean' },
          isSet: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    }),
    mounts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ...mountFields,
          isSet: { type: 'boolean' },
          sizeBytes: { type: ['number', 'null'] },
        },
        additionalProperties: false,
      },
    },
    devices: {
      type: 'array',
      items: { type: 'object', properties: { type: { type: 'string' }, device: { type: 'string' } }, additionalProperties: false },
    },
    services: {
      type: 'array',
      items: {
        type: 'object',
        properties: { port: { type: 'integer' }, type: { type: 'string' }, txt: serviceTxtSchema },
        additionalProperties: false,
      },
    },
    network: {
      type: 'object',
      properties: {
        type: { type: 'string' },
        mac: { type: 'string' },
        interface: { type: ['string', 'null'] },
        ip: { type: 'string' },
        ip6: { type: 'string' },
      },
      additionalProperties: false,
    },
    metadata: openOnPurpose({
      type: 'object',
      properties: { app: { type: 'string' }, appConfig: appConfigSchema },
    }),
    mdnsHostname: { type: ['string', 'null'] },
    pid: { type: 'integer' },
    uptime: { type: 'number' },
  },
  additionalProperties: false,
};

const imageRefSchema = { type: 'string', minLength: 1, pattern: '\\S' };

/* ── Multipart staging ────────────────────────────────────────────────── */

/**
 * Stream the request's single file part to `stagingPath` while iterating the
 * parts; a request without one answers UPLOAD_NO_FILE. The caller owns (and
 * always removes) the staging file.
 *
 * The file must be consumed as it arrives. busboy finishes the multipart body
 * only after every file stream has been read to its end, and @fastify/multipart
 * >= 10.1 ends the parts iterator only when busboy finishes — so holding a file
 * part unread while looking for more parts never completes.
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
    throw createAppError('BAD_MULTIPART_TOO_MANY_FILES', 'Only one file upload is allowed per request');
  }
  if (!staged) throw createAppError('UPLOAD_NO_FILE', `The request must include a ${what} upload`);
}

function uploadTooLargeError() {
  return createAppError('UPLOAD_TOO_LARGE', 'File too large', 'Upload exceeded the configured size limit');
}

/* ── Routes ───────────────────────────────────────────────────────────── */

export default async function containerRoutes(fastify) {
  fastify.get('/containers', {
    config: { auth: 'read' },
    schema: { response: { 200: { type: 'array', items: containerListItemSchema } } },
    handler: async () => listContainers(),
  });

  // A job, the image pull included. Only the create contract's fields reach
  // the operation: app creation fills in env, mounts and metadata itself.
  fastify.post('/containers', {
    config: { auth: 'admin' },
    schema: {
      body: {
        type: 'object',
        required: ['name', 'image'],
        properties: {
          name: containerNameSchema,
          image: imageRefSchema,
          iconId: iconIdSchema,
          app: { type: 'string', minLength: 1 },
          appConfig: appConfigSchema,
        },
        additionalProperties: false,
      },
      response: { 202: jobAckSchema },
    },
    handler: async (request, reply) => {
      const spec = request.body;
      if (spec.app !== undefined && !isKnownApp(spec.app)) {
        throw createAppError('UNKNOWN_APP_TYPE', `App "${spec.app}" is not a known app type`);
      }
      return reply.code(202).send(await startContainerCreateJob({ spec, log: request.log }));
    },
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
              updated: { type: ['string', 'null'] },
            },
            additionalProperties: false,
          },
        },
      },
    },
    handler: async () => listContainerImages(),
  });

  // A job: the delete waits for containerd's garbage collection. In use and
  // not found are answered here.
  fastify.delete('/containers/images', {
    config: { auth: 'admin' },
    schema: {
      querystring: {
        type: 'object',
        required: ['ref'],
        properties: { ref: imageRefSchema },
        additionalProperties: false,
      },
      response: { 202: jobAckSchema },
    },
    handler: async (request, reply) => {
      const imageName = await assertContainerImageDeletable(request.query.ref);
      const job = await startJob({
        kind: JOB_KIND.CONTAINER_IMAGE_DELETE,
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

  // A shared job: a running check that covers this one is joined (every
  // image covers one image; one image never covers every image). No body, or
  // an empty `ref`, checks every image.
  fastify.post('/containers/images/check-updates', {
    config: { auth: 'admin' },
    schema: {
      body: {
        type: 'object',
        nullable: true,
        properties: { ref: { type: 'string' } },
        additionalProperties: false,
      },
      response: { 202: jobAckSchema },
    },
    handler: async (request, reply) => {
      const ref = request.body?.ref?.trim() || null;
      return reply.code(202).send(await startImageUpdateCheckJob({ ref, log: request.log }));
    },
  });

  fastify.get('/containers/images/update-status', {
    config: { auth: 'read' },
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            lastCheckedAt: { type: ['string', 'null'] },
            imagesChecked: { type: 'integer' },
            imagesUpdated: { type: 'integer' },
          },
          additionalProperties: false,
        },
      },
    },
    handler: async () => getImageUpdateStatus(),
  });

  // ── One container ─────────────────────────────────────────────────
  fastify.get('/containers/:name', {
    config: { auth: 'read' },
    schema: { params: nameParams, response: { 200: containerDetailSchema } },
    handler: async (request) => maskContainerConfigSecrets(await getContainerConfig(request.params.name)),
  });

  // On-demand snapshot: sizes each mount's host-side bind source (sum of
  // file sizes). Can take seconds for large data directories.
  fastify.get('/containers/:name/mounts/usage', {
    config: { auth: 'read' },
    schema: {
      params: nameParams,
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
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
      },
    },
    handler: async (request) => getContainerMountUsage(request.params.name),
  });

  // An appConfig save stands alone: the app module regenerates the env,
  // mounts and files from it. Any other body is a configuration update, a
  // rename included (a body `name` other than the URL's runs first, the rest
  // applies under the new name).
  fastify.patch('/containers/:name', {
    config: { auth: 'admin' },
    schema: { params: nameParams, body: containerPatchSchema, response: { 204: noContentSchema } },
    handler: async (request, reply) => {
      const body = request.body;
      const { name } = request.params;
      if ('appConfig' in body) {
        const others = Object.keys(body).filter((key) => key !== 'appConfig');
        if (others.length > 0) {
          throw createAppError(
            'VALIDATION_FAILED',
            `${others.map((key) => `body/${key}`).join(', ')} cannot be sent with body/appConfig: an appConfig save stands alone`,
          );
        }
        await saveContainerAppConfig(name, () => body.appConfig);
        return reply.code(204).send();
      }
      await editContainerConfig({ name, changes: body, log: request.log });
      return reply.code(204).send();
    },
  });

  // An app container becomes a generic one; instant, like the other edits.
  fastify.post('/containers/:name/eject', {
    config: { auth: 'admin' },
    schema: { params: nameParams, response: { 204: noContentSchema } },
    handler: async (request, reply) => {
      await ejectContainerApp(request.params.name);
      return reply.code(204).send();
    },
  });

  // A job (stopping the task and removing the snapshot and files take a
  // while); a missing or busy container is answered here.
  fastify.delete('/containers/:name', {
    config: { auth: 'admin' },
    schema: {
      params: nameParams,
      querystring: {
        type: 'object',
        properties: { deleteFiles: { type: 'boolean', default: true } },
        additionalProperties: false,
      },
      response: { 202: jobAckSchema },
    },
    handler: async (request, reply) => {
      const job = await startContainerDeleteJob({
        name: request.params.name, deleteFiles: request.query.deleteFiles, log: request.log,
      });
      return reply.code(202).send(job);
    },
  });

  // Start, stop and restart are jobs; not found, busy and already running /
  // not running are answered here. Kill answers at once.
  const lifecycleJobs = [
    { path: 'start', start: startContainerStartJob },
    { path: 'stop', start: startContainerStopJob },
    { path: 'restart', start: startContainerRestartJob },
  ];
  for (const { path, start } of lifecycleJobs) {
    fastify.post(`/containers/:name/${path}`, {
      config: { auth: 'admin' },
      schema: { params: nameParams, response: { 202: jobAckSchema } },
      handler: async (request, reply) => {
        return reply.code(202).send(await start({ name: request.params.name, log: request.log }));
      },
    });
  }

  fastify.post('/containers/:name/kill', {
    config: { auth: 'admin' },
    schema: { params: nameParams, response: { 204: noContentSchema } },
    handler: async (request, reply) => {
      await killContainerNow(request.params.name);
      return reply.code(204).send();
    },
  });

  // Works on running containers too: the task is paused for the archive and
  // resumed (createContainerBackup → freezeForBackup).
  fastify.post('/containers/:name/backup', {
    config: { auth: 'admin' },
    schema: { params: nameParams, body: backupBodySchema, response: { 202: jobAckSchema } },
    handler: async (request, reply) => {
      const job = await startContainerBackupJob({
        name: request.params.name, origin: 'manual', destinationIds: request.body.destinationIds, log: request.log,
      });
      return reply.code(202).send(job);
    },
  });

  // ── Stats SSE ─────────────────────────────────────────────────────
  fastify.get('/containers/:name/stats', {
    config: { auth: 'read', answers: 'sse' },
    schema: {
      params: nameParams,
      querystring: {
        type: 'object',
        properties: { intervalMs: { type: 'integer', minimum: 2000, maximum: 60000, default: 3000 } },
        additionalProperties: false,
      },
    },
    handler: async (request, reply) => {
      const { name } = request.params;
      setupSSE(reply);

      const send = async () => {
        try {
          const config = await getContainerConfig(name);
          const stats = await getContainerStats(name);
          // `mdnsHostname` and `ip` arrive after start (the Avahi registration
          // and the DHCP lease), so the stream carries them rather than the
          // detail the client fetched when it selected the container.
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
      const timer = setInterval(send, request.query.intervalMs);
      onSSEClose(reply, () => clearInterval(timer));
    },
  });

  // ── Runs and logs ─────────────────────────────────────────────────
  fastify.get('/containers/:name/runs', {
    config: { auth: 'read' },
    schema: {
      params: nameParams,
      response: {
        200: {
          type: 'object',
          properties: {
            runs: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  runId: { type: 'string' },
                  startedAt: { type: ['string', 'null'] },
                  endedAt: { type: ['string', 'null'] },
                  exitCode: { type: ['number', 'null'] },
                  imageDigest: { type: ['string', 'null'] },
                  logSizeBytes: { type: 'integer' },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
      },
    },
    handler: async (request) => ({ runs: await listContainerRuns(request.params.name) }),
  });

  // History (tail) and live-appended lines of one run, the newest (the
  // ongoing one, if any) by default. First event `{ type: "history", lines,
  // runId }`, then `{ type: "line", line }`; the tail starts at the byte
  // offset the history ended at, so every line arrives exactly once.
  fastify.get('/containers/:name/logs', {
    config: { auth: 'read', answers: 'sse' },
    schema: {
      params: nameParams,
      querystring: {
        type: 'object',
        properties: { runId: runIdSchema },
        additionalProperties: false,
      },
    },
    handler: async (request, reply) => {
      const { name } = request.params;
      const runId = await resolveRunId(name, request.query.runId ?? null);

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
        } catch { /* the client disconnected: onSSEClose stops the tail */ }
      });

      onSSEClose(reply, () => handle.stop());
    },
  });

  fastify.get('/containers/:name/runs/:runId/log', {
    config: { auth: 'read', answers: 'download' },
    schema: { params: containerParamsSchema({ runId: runIdSchema }) },
    handler: async (request, reply) => {
      const { name } = request.params;
      const runId = await resolveRunId(name, request.params.runId);
      const filename = encodeURIComponent(`${name}-${runId}.log`);
      reply
        .header('Content-Type', 'text/plain; charset=utf-8')
        .header('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
      return reply.send(createRunLogReadStream(name, runId));
    },
  });

  // ── Mount definitions (row-scoped) ──────────────────────────────
  fastify.post('/containers/:name/mounts', {
    config: { auth: 'admin' },
    schema: { params: nameParams, body: mountBodySchema, response: { 204: noContentSchema } },
    handler: async (request, reply) => {
      await addContainerMountRow(request.params.name, request.body);
      return reply.code(204).send();
    },
  });

  fastify.patch('/containers/:name/mounts/:mountName', {
    config: { auth: 'admin' },
    schema: {
      params: mountParams,
      body: { type: 'object', properties: mountFields, additionalProperties: false },
      response: { 204: noContentSchema },
    },
    handler: async (request, reply) => {
      await editContainerMountRow(request.params.name, request.params.mountName, request.body);
      return reply.code(204).send();
    },
  });

  // A job: removing a Local mount deletes its data. Not found, app-managed
  // and busy are answered here; `done` is `{ requiresRestart }`.
  fastify.delete('/containers/:name/mounts/:mountName', {
    config: { auth: 'admin' },
    schema: { params: mountParams, response: { 202: jobAckSchema } },
    handler: async (request, reply) => {
      const { name, mountName } = request.params;
      return reply.code(202).send(await startContainerMountDeleteJob({ name, mountName, log: request.log }));
    },
  });

  // ── Mount backing store (files/<mountName>) ───────────────────────
  // The file part streams into a temp file beside the mount's file, renamed
  // over it once the whole body is read (lib/containerOperations.js): the
  // reply comes right after the upload, and every rejection leaves the mount
  // as it was.
  fastify.post('/containers/:name/mounts/:mountName/file', {
    config: { auth: 'admin' },
    schema: { params: mountParams, response: { 204: noContentSchema } },
    handler: async (request, reply) => {
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
    },
  });

  // The upload is received here; the extract that follows is a job (202).
  // Not found, app-managed, a mount that takes no zip, an invalid or unsafe
  // archive and busy are answered here.
  fastify.post('/containers/:name/mounts/:mountName/zip', {
    config: { auth: 'admin' },
    schema: { params: mountParams, response: { 202: jobAckSchema } },
    handler: async (request, reply) => {
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
    },
  });

  fastify.get('/containers/:name/mounts/:mountName/content', {
    config: { auth: 'admin' },
    schema: {
      params: mountParams,
      response: { 200: { type: 'object', properties: { content: { type: 'string' } }, additionalProperties: false } },
    },
    handler: async (request) => {
      const { name, mountName } = request.params;
      assertMountContentReadable(await getContainerConfig(name), mountName);
      return getMountFileTextContent(name, mountName);
    },
  });

  // The route's body limit refuses a 50 MB JSON payload before the handler;
  // the content itself is capped at MOUNT_FILE_CONTENT_MAX_BYTES (512 KiB) by
  // the manager, and the limit leaves headroom for the JSON around it.
  const MOUNT_FILE_PUT_BODY_LIMIT = 600 * 1024;
  fastify.put('/containers/:name/mounts/:mountName/content', {
    bodyLimit: MOUNT_FILE_PUT_BODY_LIMIT,
    ...bodyWatchHooks,
    config: { auth: 'admin' },
    schema: {
      params: mountParams,
      body: {
        type: 'object',
        required: ['content'],
        properties: { content: { type: 'string' } },
        additionalProperties: false,
      },
      response: { 204: noContentSchema },
    },
    handler: async (request, reply) => {
      const { name, mountName } = request.params;
      await putContainerMountContent(name, mountName, request.body.content);
      return reply.code(204).send();
    },
  });

  fastify.post('/containers/:name/mounts/:mountName/init', {
    config: { auth: 'admin' },
    schema: { params: mountParams, response: { 204: noContentSchema } },
    handler: async (request, reply) => {
      await initContainerMountContent(request.params.name, request.params.mountName);
      return reply.code(204).send();
    },
  });

  // A job: a large data directory takes a while to delete. Not found,
  // app-managed, a tmpfs mount and busy are answered here.
  fastify.delete('/containers/:name/mounts/:mountName/data', {
    config: { auth: 'admin' },
    schema: { params: mountParams, response: { 202: jobAckSchema } },
    handler: async (request, reply) => {
      const { name, mountName } = request.params;
      return reply.code(202).send(await startContainerMountDataDeleteJob({ name, mountName, log: request.log }));
    },
  });

  // ── mDNS service advertisements (row-scoped, keyed by port) ─────
  fastify.post('/containers/:name/services', {
    config: { auth: 'admin' },
    schema: {
      params: nameParams,
      body: {
        type: 'object',
        required: ['port', 'type'],
        properties: { port: servicePortSchema, type: { type: 'string' }, txt: serviceTxtSchema },
        additionalProperties: false,
      },
      response: { 204: noContentSchema },
    },
    handler: async (request, reply) => {
      await addContainerServiceRow(request.params.name, request.body);
      return reply.code(204).send();
    },
  });

  fastify.patch('/containers/:name/services/:port', {
    config: { auth: 'admin' },
    schema: {
      params: serviceParams,
      body: {
        type: 'object',
        properties: { type: { type: 'string' }, txt: serviceTxtSchema },
        additionalProperties: false,
      },
      response: { 204: noContentSchema },
    },
    handler: async (request, reply) => {
      const { name, port } = request.params;
      await editContainerServiceRow(name, port, request.body);
      return reply.code(204).send();
    },
  });

  fastify.delete('/containers/:name/services/:port', {
    config: { auth: 'admin' },
    schema: { params: serviceParams, response: { 204: noContentSchema } },
    handler: async (request, reply) => {
      const { name, port } = request.params;
      await removeContainerServiceRow(name, port);
      return reply.code(204).send();
    },
  });
}
