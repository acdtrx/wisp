/**
 * The `wisp` CLI's downloads (docs/specs/CLI.md, Getting it): public, since
 * the files hold no secret and are the same on every Wisp of a version.
 */
import { availableCliPlatforms, cliInstallScript, openCliBinary, requestCliBaseUrl } from '../lib/cliDistribution.js';
import { getCurrentVersion } from '../lib/wispUpdate.js';

export default async function cliRoutes(fastify) {
  fastify.get('/cli', {
    config: { auth: 'public' },
    schema: {
      response: {
        200: {
          type: 'object',
          required: ['version', 'platforms'],
          properties: {
            version: { type: 'string' },
            platforms: { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: false,
        },
      },
    },
    handler: async () => ({ version: getCurrentVersion(), platforms: availableCliPlatforms() }),
  });

  for (const name of ['install.sh', 'install.ps1']) {
    fastify.get(`/cli/${name}`, {
      config: { auth: 'public', answers: 'download' },
      handler: async (request, reply) => {
        const { body, type } = cliInstallScript(name, await requestCliBaseUrl(request));
        reply.header('Content-Type', type).header('Cache-Control', 'no-store');
        return reply.send(body);
      },
    });
  }

  fastify.get('/cli/wisp-:platform', {
    config: { auth: 'public', answers: 'download' },
    schema: {
      params: {
        type: 'object',
        required: ['platform'],
        properties: { platform: { type: 'string', minLength: 1, maxLength: 64 } },
        additionalProperties: false,
      },
    },
    handler: async (request, reply) => {
      const { stream, size, filename } = openCliBinary(request.params.platform);
      reply
        .header('Content-Type', 'application/octet-stream')
        .header('Content-Length', String(size))
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .header('Cache-Control', 'no-store');
      return reply.send(stream);
    },
  });
}
