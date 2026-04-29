import { readdir, stat, unlink, rename, access } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join, basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';
import * as downloadJobStore from '../lib/downloadJobStore.js';
import { checkUrl, downloadToLibrary, isAllowedUrl } from '../lib/downloadFromUrl.js';
import { downloadAndDecompressHaos } from '../lib/downloadHaos.js';
import { downloadUbuntuCloudImage } from '../lib/downloadUbuntuCloud.js';
import { downloadArchCloudImage } from '../lib/downloadArchCloud.js';
import { ensureImageDir, getImagePath } from '../lib/paths.js';
import { detectType } from '../lib/fileTypes.js';
import { setupSSE } from '../lib/sse.js';
import { sendError } from '../lib/routeErrors.js';
import { BACKGROUND_JOB_KIND } from '../lib/backgroundJobKinds.js';
import {
  titleForLibraryDownloadUrl,
  TITLE_LIBRARY_ARCH_CLOUD,
  TITLE_LIBRARY_HAOS,
  TITLE_LIBRARY_UBUNTU_CLOUD,
} from '../lib/backgroundJobTitles.js';

function validateFilename(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return false;
  if (name.startsWith('.')) return false;
  if (name !== basename(name)) return false;
  return true;
}

export default async function libraryRoutes(fastify) {

  fastify.get('/library', {
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
    handler: async (request, reply) => {
      const dir = await ensureImageDir();
      const typeFilter = request.query.type;

      let entries;
      try {
        entries = await readdir(dir);
      } catch (err) {
        return sendError(reply, 500, 'Failed to read image directory', err.message);
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

  fastify.post('/library/upload', {
    schema: {
      response: {
        200: {
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
    handler: async (request, reply) => {
      const dir = await ensureImageDir();
      const data = await request.file();

      if (!data) {
        reply.code(400).send({ error: 'No file provided', detail: 'Request must include a file upload' });
        return;
      }

      const filename = basename(data.filename);
      if (!validateFilename(filename)) {
        reply.code(422).send({ error: 'Invalid filename', detail: 'Filename contains invalid characters' });
        return;
      }

      const destPath = join(dir, filename);

      try {
        await access(destPath);
        reply.code(409).send({ error: 'File already exists', detail: `A file named "${filename}" already exists in the library` });
        return;
      } catch {
        /* destination free — proceed with upload */
      }

      // Stream to disk. fastify-multipart sets `data.file.truncated` when the
      // configured fileSize limit is exceeded; the pipeline still resolves
      // successfully, so we must check explicitly. On any failure path,
      // unlink the partial file to avoid disk-fill DoS.
      try {
        await pipeline(data.file, createWriteStream(destPath));
      } catch (err) {
        await unlink(destPath).catch(() => { /* best-effort cleanup */ });
        reply.code(500).send({ error: 'Upload failed', detail: err.message });
        return;
      }

      if (data.file.truncated) {
        await unlink(destPath).catch(() => { /* best-effort cleanup */ });
        reply.code(422).send({ error: 'File too large', detail: 'Upload exceeded the configured size limit' });
        return;
      }

      const info = await stat(destPath);
      return {
        name: filename,
        type: detectType(filename),
        size: info.size,
        modified: info.mtime.toISOString(),
      };
    },
  });

  fastify.delete('/library/:filename', {
    schema: {
      params: {
        type: 'object',
        required: ['filename'],
        properties: {
          filename: { type: 'string' },
        },
      },
    },
    handler: async (request, reply) => {
      const { filename } = request.params;

      if (!validateFilename(filename)) {
        reply.code(422).send({ error: 'Invalid filename', detail: 'Filename contains invalid characters' });
        return;
      }

      const dir = getImagePath();
      const filePath = join(dir, filename);

      try {
        await access(filePath);
      } catch {
        /* ENOENT or unreadable */
        reply.code(404).send({ error: 'File not found', detail: `"${filename}" does not exist in the library` });
        return;
      }

      try {
        await unlink(filePath);
      } catch (err) {
        reply.code(500).send({ error: 'Delete failed', detail: err.message });
        return;
      }

      return { ok: true };
    },
  });

  // GET /library/check-url — HEAD request to verify URL is reachable
  fastify.get('/library/check-url', {
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
    handler: async (request, reply) => {
      const { url } = request.query;
      if (!url || typeof url !== 'string') {
        return reply.code(400).send({ error: 'Missing url', detail: 'Query parameter url is required' });
      }
      const result = await checkUrl(url);
      return result;
    },
  });

  // POST /library/download — start URL download (returns jobId), progress via SSE
  fastify.post('/library/download', {
    schema: {
      body: {
        type: 'object',
        required: ['url'],
        properties: { url: { type: 'string' } },
        additionalProperties: false,
      },
      response: {
        201: {
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
        return reply.code(400).send({ error: 'Missing url', detail: 'Request body must include url' });
      }
      if (!isAllowedUrl(url)) {
        return reply.code(422).send({ error: 'Invalid URL', detail: 'Only HTTP and HTTPS URLs are allowed' });
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
          const result = await downloadToLibrary(url, (percent, loaded, total) => {
            downloadJobStore.pushEvent(jobId, { step: 'progress', percent, loaded, total });
          });
          downloadJobStore.completeJob(jobId, result);
        } catch (err) {
          request.log.error({ err, jobId }, 'Background download job failed');
          try {
            downloadJobStore.failJob(jobId, err);
          } catch (failErr) {
            /* failJob threw — job may already be finalized */
            request.log.error({ err: failErr, jobId }, 'failJob failed');
          }
        }
      })();
      return reply.code(201).send({ jobId, title });
    },
  });

  // POST /library/download-ubuntu-cloud — start Ubuntu Server LTS cloud image download (returns jobId)
  fastify.post('/library/download-ubuntu-cloud', {
    schema: {
      response: {
        201: {
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
          const result = await downloadUbuntuCloudImage((percent) => {
            downloadJobStore.pushEvent(jobId, { step: 'progress', percent, loaded: null, total: null });
          });
          downloadJobStore.completeJob(jobId, result);
        } catch (err) {
          request.log.error({ err, jobId }, 'Background download-ubuntu-cloud job failed');
          try {
            downloadJobStore.failJob(jobId, err);
          } catch (failErr) {
            /* failJob threw — job may already be finalized */
            request.log.error({ err: failErr, jobId }, 'failJob failed');
          }
        }
      })();
      return reply.code(201).send({ jobId, title });
    },
  });

  // POST /library/download-arch-cloud — start Arch Linux cloud image download (returns jobId)
  fastify.post('/library/download-arch-cloud', {
    schema: {
      response: {
        201: {
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
          const result = await downloadArchCloudImage((percent) => {
            downloadJobStore.pushEvent(jobId, { step: 'progress', percent, loaded: null, total: null });
          });
          downloadJobStore.completeJob(jobId, result);
        } catch (err) {
          request.log.error({ err, jobId }, 'Background download-arch-cloud job failed');
          try {
            downloadJobStore.failJob(jobId, err);
          } catch (failErr) {
            request.log.error({ err: failErr, jobId }, 'failJob failed');
          }
        }
      })();
      return reply.code(201).send({ jobId, title });
    },
  });

  // POST /library/download-haos — start Home Assistant OS download (returns jobId)
  fastify.post('/library/download-haos', {
    schema: {
      response: {
        201: {
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
          const result = await downloadAndDecompressHaos((percent, phase) => {
            if (phase === 'decompressing') {
              downloadJobStore.pushEvent(jobId, { step: 'decompressing' });
            } else {
              downloadJobStore.pushEvent(jobId, { step: 'progress', percent, loaded: null, total: null });
            }
          });
          downloadJobStore.completeJob(jobId, result);
        } catch (err) {
          request.log.error({ err, jobId }, 'Background download-haos job failed');
          try {
            downloadJobStore.failJob(jobId, err);
          } catch (failErr) {
            /* failJob threw — job may already be finalized */
            request.log.error({ err: failErr, jobId }, 'failJob failed');
          }
        }
      })();
      return reply.code(201).send({ jobId, title });
    },
  });

  // GET /library/download-progress/:jobId — SSE stream for download progress
  fastify.get('/library/download-progress/:jobId', {
    schema: { hide: true },
    config: { acceptQueryToken: true },
    handler: async (request, reply) => {
      const { jobId } = request.params;
      const job = downloadJobStore.getJob(jobId);
      if (!job) {
        return reply.code(404).send({ error: 'Job not found', detail: jobId });
      }
      setupSSE(reply);
      const ok = downloadJobStore.registerStream(jobId, reply.raw);
      if (!ok) {
        reply.raw.end();
        return;
      }
      request.raw.on('close', () => {
        downloadJobStore.unregisterStream(jobId, reply.raw);
      });
    },
  });

  fastify.patch('/library/:filename', {
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
    },
    handler: async (request, reply) => {
      const { filename } = request.params;
      const { name: newName } = request.body;

      if (!validateFilename(filename)) {
        reply.code(422).send({ error: 'Invalid filename', detail: 'Current filename contains invalid characters' });
        return;
      }

      if (!validateFilename(newName)) {
        reply.code(422).send({ error: 'Invalid new name', detail: 'New filename contains invalid characters' });
        return;
      }

      const dir = getImagePath();
      const oldPath = join(dir, filename);
      const newPath = join(dir, newName);

      try {
        await access(oldPath);
      } catch {
        /* source missing */
        reply.code(404).send({ error: 'File not found', detail: `"${filename}" does not exist in the library` });
        return;
      }

      if (filename !== newName) {
        try {
          await access(newPath);
          reply.code(409).send({ error: 'Name already taken', detail: `A file named "${newName}" already exists` });
          return;
        } catch {
          /* target name free — proceed with rename */
        }
      }

      try {
        await rename(oldPath, newPath);
      } catch (err) {
        reply.code(500).send({ error: 'Rename failed', detail: err.message });
        return;
      }

      const info = await stat(newPath);
      return {
        name: newName,
        type: detectType(newName),
        size: info.size,
        modified: info.mtime.toISOString(),
      };
    },
  });
}
