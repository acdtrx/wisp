import { readdir, stat, access } from 'node:fs/promises';
import { join, basename } from 'node:path';
import {
  startJob,
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
import { createAppError, isAppError } from '../lib/appErrors.js';
import { watchRequestBody } from '../lib/requestBodyWatch.js';
import { jobAckSchema } from './schemas.js';

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

  // POST /library/download — a URL download job
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
        202: jobAckSchema,
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
      const job = await startJob({
        kind: BACKGROUND_JOB_KIND.LIBRARY_DOWNLOAD,
        title: titleForLibraryDownloadUrl(url),
        log: request.log,
        run: (report) => downloadUrlToLibrary(url, (percent, loaded, total) => {
          report({ step: 'progress', percent, loaded, total });
        }),
      });
      return reply.code(202).send(job);
    },
  });

  // POST /library/download-ubuntu-cloud — a job downloading the Ubuntu Server LTS cloud image
  fastify.post('/library/download-ubuntu-cloud', {
    config: { auth: 'admin' },
    schema: {
      response: {
        202: jobAckSchema,
      },
    },
    handler: async (request, reply) => {
      const job = await startJob({
        kind: BACKGROUND_JOB_KIND.LIBRARY_DOWNLOAD,
        title: TITLE_LIBRARY_UBUNTU_CLOUD,
        log: request.log,
        run: (report) => downloadUbuntuCloudToLibrary((percent) => {
          report({ step: 'progress', percent, loaded: null, total: null });
        }),
      });
      return reply.code(202).send(job);
    },
  });

  // POST /library/download-arch-cloud — a job downloading the Arch Linux cloud image
  fastify.post('/library/download-arch-cloud', {
    config: { auth: 'admin' },
    schema: {
      response: {
        202: jobAckSchema,
      },
    },
    handler: async (request, reply) => {
      const job = await startJob({
        kind: BACKGROUND_JOB_KIND.LIBRARY_DOWNLOAD,
        title: TITLE_LIBRARY_ARCH_CLOUD,
        log: request.log,
        run: (report) => downloadArchCloudToLibrary((percent) => {
          report({ step: 'progress', percent, loaded: null, total: null });
        }),
      });
      return reply.code(202).send(job);
    },
  });

  // POST /library/download-haos — a job downloading Home Assistant OS
  fastify.post('/library/download-haos', {
    config: { auth: 'admin' },
    schema: {
      response: {
        202: jobAckSchema,
      },
    },
    handler: async (request, reply) => {
      const job = await startJob({
        kind: BACKGROUND_JOB_KIND.LIBRARY_DOWNLOAD,
        title: TITLE_LIBRARY_HAOS,
        log: request.log,
        run: (report) => downloadHaosToLibrary({
          onProgress: (percent) => {
            report({ step: 'progress', percent, loaded: null, total: null });
          },
          onDecompressing: () => {
            report({ step: 'decompressing' });
          },
        }),
      });
      return reply.code(202).send(job);
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
