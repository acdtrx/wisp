import { readdir, stat, access } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  downloadJobStore,
  BACKGROUND_JOB_KIND,
  titleForLibraryDownloadUrl,
  TITLE_LIBRARY_ARCH_CLOUD,
  TITLE_LIBRARY_HAOS,
  TITLE_LIBRARY_UBUNTU_CLOUD,
} from '../lib/jobs/index.js';
import { checkUrl, isAllowedUrl, detectType } from '../lib/downloads/index.js';
import {
  saveLibraryUpload,
  renameLibraryFile,
  deleteLibraryFile,
  downloadUrlToLibrary,
  downloadUbuntuCloudToLibrary,
  downloadArchCloudToLibrary,
  downloadHaosToLibrary,
} from '../lib/library/index.js';
import { ensureImageDir, getImagePath } from '../lib/paths.js';
import { findVMsUsingImage } from '../lib/vmManager/index.js';
import { onSSEClose, setupSSE } from '../lib/sse.js';
import { createAppError, isAppError, isExpectedAppError } from '../lib/appErrors.js';
import { watchRequestBody } from '../lib/requestBodyWatch.js';

function validateFilename(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return false;
  if (name.startsWith('.')) return false;
  if (name !== basename(name)) return false;
  return true;
}

export default async function libraryRoutes(fastify) {

  fastify.get('/library', {
    config: { auth: 'read' },
    schema: {
      querystring: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['iso', 'disk'] },
        },
        additionalProperties: false,
      },
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string' },
              size: { type: 'number' },
              modified: { type: 'string' },
            },
          },
        },
      },
    },
    handler: async (request) => {
      const dir = await ensureImageDir();
      const typeFilter = request.query.type;

      let entries;
      try {
        entries = await readdir(dir);
      } catch (err) {
        throw createAppError('LIBRARY_IO_FAILED', 'Failed to read the image library', err.message);
      }

      const files = [];
      for (const entry of entries) {
        if (entry.startsWith('.')) continue;
        const filePath = join(dir, entry);
        try {
          const info = await stat(filePath);
          if (!info.isFile()) continue;

          const type = detectType(entry);
          if (typeFilter && type !== typeFilter) continue;

          files.push({
            name: entry,
            type,
            size: info.size,
            modified: info.mtime.toISOString(),
          });
        } catch {
          /* skip entries we cannot stat (race or permission) */
        }
      }

      files.sort((a, b) => a.name.localeCompare(b.name));
      return files;
    },
  });

  // Answers 204 once the file is in the library; the list follows on the
  // `library` cue the library module announces.
  fastify.post('/library/upload', {
    config: { auth: 'admin' },
    schema: {
      response: { 204: { type: 'null' } },
    },
    handler: async (request, reply) => {
      const bodyWatch = watchRequestBody(request); // IMAGE-LIBRARY.md § Timeouts
      try {
        return await receiveUpload(request, reply);
      } finally {
        bodyWatch.stop();
      }
    },
  });

  async function receiveUpload(request, reply) {
    const data = await request.file();

    if (!data) {
      throw createAppError('UPLOAD_NO_FILE', 'The request must include a file upload');
    }

    const filename = basename(data.filename);
    if (!validateFilename(filename)) {
      throw createAppError('INVALID_FILENAME', `Filename "${filename}" contains invalid characters`);
    }

    // fastify-multipart sets `data.file.truncated` when the configured fileSize
    // limit is exceeded; the library module checks it once the stream ends.
    try {
      await saveLibraryUpload(filename, data.file);
    } catch (err) {
      if (err.code === 'EEXIST') {
        throw createAppError('LIBRARY_FILE_EXISTS', `A file named "${filename}" already exists in the library`);
      }
      if (isAppError(err)) throw err;
      throw createAppError('LIBRARY_IO_FAILED', `Failed to save the upload "${filename}"`, err.message);
    }
    reply.code(204).send();
  }

  fastify.delete('/library/:filename', {
    config: { auth: 'admin' },
    schema: {
      params: {
        type: 'object',
        required: ['filename'],
        properties: {
          filename: { type: 'string' },
        },
      },
      response: { 204: { type: 'null' } },
    },
    handler: async (request, reply) => {
      const { filename } = request.params;

      if (!validateFilename(filename)) {
        throw createAppError('INVALID_FILENAME', `Filename "${filename}" contains invalid characters`);
      }

      const dir = getImagePath();
      const filePath = join(dir, filename);

      try {
        await access(filePath);
      } catch {
        /* ENOENT or unreadable */
        throw createAppError('LIBRARY_FILE_NOT_FOUND', `"${filename}" does not exist in the library`);
      }

      // Refuse to remove a library file that's still referenced by any VM —
      // otherwise the next VM start would fail with "no such file" because
      // the domain XML still points at the now-missing path. Symmetrical with
      // assertBridgeNotInUse for managed bridges.
      const inUseBy = await findVMsUsingImage(filePath);
      if (inUseBy.length > 0) {
        throw createAppError('LIBRARY_FILE_IN_USE', `Detach "${filename}" from these VMs first: ${inUseBy.join(', ')}`);
      }

      try {
        await deleteLibraryFile(filename);
      } catch (err) {
        throw createAppError('LIBRARY_IO_FAILED', `Failed to delete "${filename}"`, err.message);
      }

      reply.code(204).send();
    },
  });

  // GET /library/check-url — HEAD request to verify URL is reachable
  fastify.get('/library/check-url', {
    config: { auth: 'admin' },
    schema: {
      querystring: {
        type: 'object',
        required: ['url'],
        properties: { url: { type: 'string' } },
        additionalProperties: false,
      },
      response: {
        200: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            contentLength: { type: 'number', nullable: true },
            error: { type: 'string' },
            status: { type: 'number' },
          },
        },
      },
    },
    handler: async (request) => {
      const { url } = request.query;
      if (!url || typeof url !== 'string') {
        throw createAppError('VALIDATION_FAILED', 'querystring/url is required');
      }
      const result = await checkUrl(url);
      return result;
    },
  });

  // POST /library/download — start URL download (returns jobId), progress via SSE
  fastify.post('/library/download', {
    config: { auth: 'admin' },
    schema: {
      body: {
        type: 'object',
        required: ['url'],
        properties: { url: { type: 'string' } },
        additionalProperties: false,
      },
      response: {
        202: {
          type: 'object',
          properties: {
            jobId: { type: 'string' },
            title: { type: 'string' },
          },
        },
      },
    },
    handler: async (request, reply) => {
      const { url } = request.body;
      if (!url || typeof url !== 'string') {
        throw createAppError('VALIDATION_FAILED', 'body/url is required');
      }
      if (!isAllowedUrl(url)) {
        throw createAppError('INVALID_URL', 'Only HTTP and HTTPS URLs are allowed');
      }
      const jobId = randomBytes(12).toString('hex');
      const title = titleForLibraryDownloadUrl(url);
      downloadJobStore.createJob(jobId, {
        kind: BACKGROUND_JOB_KIND.LIBRARY_DOWNLOAD,
        title,
        log: request.log,
      });
      request.log.info(
        { jobId, kind: BACKGROUND_JOB_KIND.LIBRARY_DOWNLOAD, title },
        'Background job started',
      );
      (async () => {
        try {
          const result = await downloadUrlToLibrary(url, (percent, loaded, total) => {
            downloadJobStore.pushEvent(jobId, { step: 'progress', percent, loaded, total });
          });
          downloadJobStore.completeJob(jobId, result);
        } catch (err) {
          if (!isExpectedAppError(err)) request.log.error({ err, jobId }, 'Background download job failed');
          try {
            downloadJobStore.failJob(jobId, err);
          } catch (failErr) {
            /* failJob threw — job may already be finalized */
            request.log.error({ err: failErr, jobId }, 'failJob failed');
          }
        }
      })();
      return reply.code(202).send({ jobId, title });
    },
  });

  // POST /library/download-ubuntu-cloud — start Ubuntu Server LTS cloud image download (returns jobId)
  fastify.post('/library/download-ubuntu-cloud', {
    config: { auth: 'admin' },
    schema: {
      response: {
        202: {
          type: 'object',
          properties: {
            jobId: { type: 'string' },
            title: { type: 'string' },
          },
        },
      },
    },
    handler: async (request, reply) => {
      const jobId = randomBytes(12).toString('hex');
      const title = TITLE_LIBRARY_UBUNTU_CLOUD;
      downloadJobStore.createJob(jobId, {
        kind: BACKGROUND_JOB_KIND.LIBRARY_DOWNLOAD,
        title,
        log: request.log,
      });
      request.log.info(
        { jobId, kind: BACKGROUND_JOB_KIND.LIBRARY_DOWNLOAD, title },
        'Background job started',
      );
      (async () => {
        try {
          const result = await downloadUbuntuCloudToLibrary((percent) => {
            downloadJobStore.pushEvent(jobId, { step: 'progress', percent, loaded: null, total: null });
          });
          downloadJobStore.completeJob(jobId, result);
        } catch (err) {
          if (!isExpectedAppError(err)) request.log.error({ err, jobId }, 'Background download-ubuntu-cloud job failed');
          try {
            downloadJobStore.failJob(jobId, err);
          } catch (failErr) {
            /* failJob threw — job may already be finalized */
            request.log.error({ err: failErr, jobId }, 'failJob failed');
          }
        }
      })();
      return reply.code(202).send({ jobId, title });
    },
  });

  // POST /library/download-arch-cloud — start Arch Linux cloud image download (returns jobId)
  fastify.post('/library/download-arch-cloud', {
    config: { auth: 'admin' },
    schema: {
      response: {
        202: {
          type: 'object',
          properties: {
            jobId: { type: 'string' },
            title: { type: 'string' },
          },
        },
      },
    },
    handler: async (request, reply) => {
      const jobId = randomBytes(12).toString('hex');
      const title = TITLE_LIBRARY_ARCH_CLOUD;
      downloadJobStore.createJob(jobId, {
        kind: BACKGROUND_JOB_KIND.LIBRARY_DOWNLOAD,
        title,
        log: request.log,
      });
      request.log.info(
        { jobId, kind: BACKGROUND_JOB_KIND.LIBRARY_DOWNLOAD, title },
        'Background job started',
      );
      (async () => {
        try {
          const result = await downloadArchCloudToLibrary((percent) => {
            downloadJobStore.pushEvent(jobId, { step: 'progress', percent, loaded: null, total: null });
          });
          downloadJobStore.completeJob(jobId, result);
        } catch (err) {
          if (!isExpectedAppError(err)) request.log.error({ err, jobId }, 'Background download-arch-cloud job failed');
          try {
            downloadJobStore.failJob(jobId, err);
          } catch (failErr) {
            request.log.error({ err: failErr, jobId }, 'failJob failed');
          }
        }
      })();
      return reply.code(202).send({ jobId, title });
    },
  });

  // POST /library/download-haos — start Home Assistant OS download (returns jobId)
  fastify.post('/library/download-haos', {
    config: { auth: 'admin' },
    schema: {
      response: {
        202: {
          type: 'object',
          properties: {
            jobId: { type: 'string' },
            title: { type: 'string' },
          },
        },
      },
    },
    handler: async (request, reply) => {
      const jobId = randomBytes(12).toString('hex');
      const title = TITLE_LIBRARY_HAOS;
      downloadJobStore.createJob(jobId, {
        kind: BACKGROUND_JOB_KIND.LIBRARY_DOWNLOAD,
        title,
        log: request.log,
      });
      request.log.info(
        { jobId, kind: BACKGROUND_JOB_KIND.LIBRARY_DOWNLOAD, title },
        'Background job started',
      );
      (async () => {
        try {
          const result = await downloadHaosToLibrary({
            onProgress: (percent) => {
              downloadJobStore.pushEvent(jobId, { step: 'progress', percent, loaded: null, total: null });
            },
            onDecompressing: () => {
              downloadJobStore.pushEvent(jobId, { step: 'decompressing' });
            },
          });
          downloadJobStore.completeJob(jobId, result);
        } catch (err) {
          if (!isExpectedAppError(err)) request.log.error({ err, jobId }, 'Background download-haos job failed');
          try {
            downloadJobStore.failJob(jobId, err);
          } catch (failErr) {
            /* failJob threw — job may already be finalized */
            request.log.error({ err: failErr, jobId }, 'failJob failed');
          }
        }
      })();
      return reply.code(202).send({ jobId, title });
    },
  });

  // GET /library/download-progress/:jobId — SSE stream for download progress
  fastify.get('/library/download-progress/:jobId', {
    config: { auth: 'read' },
    schema: { hide: true },
    handler: async (request, reply) => {
      const { jobId } = request.params;
      const job = downloadJobStore.getJob(jobId);
      if (!job) {
        throw createAppError('JOB_NOT_FOUND', `No job with id "${jobId}": it never started, or ended more than 5 minutes ago`);
      }
      setupSSE(reply);
      const ok = downloadJobStore.registerStream(jobId, reply.raw);
      if (!ok) {
        reply.raw.end();
        return;
      }
      onSSEClose(reply, () => {
        downloadJobStore.unregisterStream(jobId, reply.raw);
      });
    },
  });

  fastify.patch('/library/:filename', {
    config: { auth: 'admin' },
    schema: {
      params: {
        type: 'object',
        required: ['filename'],
        properties: {
          filename: { type: 'string' },
        },
      },
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1 },
        },
        additionalProperties: false,
      },
      response: { 204: { type: 'null' } },
    },
    handler: async (request, reply) => {
      const { filename } = request.params;
      const { name: newName } = request.body;

      if (!validateFilename(filename)) {
        throw createAppError('INVALID_FILENAME', `Filename "${filename}" contains invalid characters`);
      }

      if (!validateFilename(newName)) {
        throw createAppError('INVALID_FILENAME', `New filename "${newName}" contains invalid characters`);
      }

      const dir = getImagePath();
      const oldPath = join(dir, filename);
      const newPath = join(dir, newName);

      try {
        await access(oldPath);
      } catch {
        /* source missing */
        throw createAppError('LIBRARY_FILE_NOT_FOUND', `"${filename}" does not exist in the library`);
      }

      if (filename !== newName) {
        const taken = await access(newPath).then(() => true, () => false);
        if (taken) {
          throw createAppError('LIBRARY_FILE_EXISTS', `A file named "${newName}" already exists in the library`);
        }
      }

      // Refuse to rename a library file that's referenced by any VM (same
      // reasoning as DELETE) — if we renamed it under a running domain's feet
      // its next start would fail.
      if (filename !== newName) {
        const inUseBy = await findVMsUsingImage(oldPath);
        if (inUseBy.length > 0) {
          throw createAppError('LIBRARY_FILE_IN_USE', `Detach "${filename}" from these VMs first: ${inUseBy.join(', ')}`);
        }
      }

      try {
        await renameLibraryFile(filename, newName);
      } catch (err) {
        throw createAppError('LIBRARY_IO_FAILED', `Failed to rename "${filename}" to "${newName}"`, err.message);
      }

      reply.code(204).send();
    },
  });
}
