/**
 * Image library routes: the listing, upload, rename and delete (each a call
 * of lib/library), the URL check, and the downloads, which are jobs.
 */
import {
  startJob,
  BACKGROUND_JOB_KIND,
  titleForLibraryDownloadUrl,
  TITLE_LIBRARY_ARCH_CLOUD,
  TITLE_LIBRARY_HAOS,
  TITLE_LIBRARY_UBUNTU_CLOUD,
} from '../lib/jobs/index.js';
import { checkUrl, isAllowedUrl } from '../lib/downloads/index.js';
import {
  listLibraryFiles,
  saveLibraryUpload,
  renameLibraryFile,
  deleteLibraryFile,
  downloadUrlToLibrary,
  downloadUbuntuCloudToLibrary,
  downloadArchCloudToLibrary,
  downloadHaosToLibrary,
} from '../lib/library/index.js';
import { createAppError } from '../lib/appErrors.js';
import { watchRequestBody } from '../lib/requestBodyWatch.js';
import { jobAckSchema, noContentSchema } from './schemas.js';

/** `:filename` of a library file; lib/library checks it is one. */
const filenameParams = {
  type: 'object',
  required: ['filename'],
  properties: { filename: { type: 'string', minLength: 1 } },
  additionalProperties: false,
};

const urlSchema = { type: 'string', minLength: 1 };

/** The progress of a download whose size the job reports as a percent only. */
const reportPercent = (report) => (percent) => report({ step: 'progress', percent, loaded: null, total: null });

export default async function libraryRoutes(fastify) {
  fastify.get('/library', {
    config: { auth: 'read' },
    schema: {
      querystring: {
        type: 'object',
        properties: { type: { type: 'string', enum: ['iso', 'disk'] } },
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
            additionalProperties: false,
          },
        },
      },
    },
    handler: async (request) => listLibraryFiles(request.query.type),
  });

  // Answers 204 once the file is in the library; the list follows on the
  // `library` cue the library module announces.
  fastify.post('/library/upload', {
    config: { auth: 'admin' },
    schema: { response: { 204: noContentSchema } },
    handler: async (request, reply) => {
      const bodyWatch = watchRequestBody(request); // IMAGE-LIBRARY.md § Timeouts
      try {
        const data = await request.file();
        if (!data) throw createAppError('UPLOAD_NO_FILE', 'The request must include a file upload');
        // fastify-multipart sets `data.file.truncated` past the fileSize limit;
        // the library checks it once the stream ends.
        await saveLibraryUpload(data.filename, data.file);
        return reply.code(204).send();
      } finally {
        bodyWatch.stop();
      }
    },
  });

  fastify.delete('/library/:filename', {
    config: { auth: 'admin' },
    schema: { params: filenameParams, response: { 204: noContentSchema } },
    handler: async (request, reply) => {
      await deleteLibraryFile(request.params.filename);
      return reply.code(204).send();
    },
  });

  fastify.patch('/library/:filename', {
    config: { auth: 'admin' },
    schema: {
      params: filenameParams,
      body: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', minLength: 1 } },
        additionalProperties: false,
      },
      response: { 204: noContentSchema },
    },
    handler: async (request, reply) => {
      await renameLibraryFile(request.params.filename, request.body.name);
      return reply.code(204).send();
    },
  });

  // A HEAD request: whether the URL is reachable, and its size. A URL that is
  // not is the check's result, not an error answer.
  fastify.get('/library/check-url', {
    config: { auth: 'admin' },
    schema: {
      querystring: {
        type: 'object',
        required: ['url'],
        properties: { url: urlSchema },
        additionalProperties: false,
      },
      response: {
        200: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            contentLength: { type: ['integer', 'null'] },
            error: { type: 'string' },
            detail: { type: 'string' },
            status: { type: 'integer' },
          },
          additionalProperties: false,
        },
      },
    },
    handler: async (request) => checkUrl(request.query.url),
  });

  fastify.post('/library/download', {
    config: { auth: 'admin' },
    schema: {
      body: {
        type: 'object',
        required: ['url'],
        properties: { url: urlSchema },
        additionalProperties: false,
      },
      response: { 202: jobAckSchema },
    },
    handler: async (request, reply) => {
      const { url } = request.body;
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

  // The cloud images Wisp knows where to find: Ubuntu Server LTS, Arch Linux, Home Assistant OS.
  fastify.post('/library/download-ubuntu-cloud', {
    config: { auth: 'admin' },
    schema: { response: { 202: jobAckSchema } },
    handler: async (request, reply) => {
      const job = await startJob({
        kind: BACKGROUND_JOB_KIND.LIBRARY_DOWNLOAD,
        title: TITLE_LIBRARY_UBUNTU_CLOUD,
        log: request.log,
        run: (report) => downloadUbuntuCloudToLibrary(reportPercent(report)),
      });
      return reply.code(202).send(job);
    },
  });

  fastify.post('/library/download-arch-cloud', {
    config: { auth: 'admin' },
    schema: { response: { 202: jobAckSchema } },
    handler: async (request, reply) => {
      const job = await startJob({
        kind: BACKGROUND_JOB_KIND.LIBRARY_DOWNLOAD,
        title: TITLE_LIBRARY_ARCH_CLOUD,
        log: request.log,
        run: (report) => downloadArchCloudToLibrary(reportPercent(report)),
      });
      return reply.code(202).send(job);
    },
  });

  fastify.post('/library/download-haos', {
    config: { auth: 'admin' },
    schema: { response: { 202: jobAckSchema } },
    handler: async (request, reply) => {
      const job = await startJob({
        kind: BACKGROUND_JOB_KIND.LIBRARY_DOWNLOAD,
        title: TITLE_LIBRARY_HAOS,
        log: request.log,
        run: (report) => downloadHaosToLibrary({
          onProgress: reportPercent(report),
          onDecompressing: () => report({ step: 'decompressing' }),
        }),
      });
      return reply.code(202).send(job);
    },
  });
}
