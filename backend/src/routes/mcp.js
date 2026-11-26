/**
 * MCP endpoint (streamable HTTP, stateless, POST-only). The `mcp` access level
 * makes the global auth hook accept ONLY bearer API tokens here — cookies are
 * ignored entirely, which also makes the endpoint CSRF-irrelevant. The token's
 * scope rides on request.user and gates which tools are listed/callable.
 */
import { createAppError } from '../lib/appErrors.js';
import { requestCliBaseUrl } from '../lib/cliDistribution.js';
import { openOnPurpose } from '../lib/schemaValidation.js';
import { handleMcpMessage } from '../lib/mcp/mcpServer.js';

export default async function mcpRoutes(fastify) {
  // The body is a JSON-RPC message, which the MCP server checks and answers
  // in JSON-RPC's own terms (an invalid request is a JSON-RPC error, not a 400).
  fastify.post('/mcp', {
    config: { auth: 'mcp', answers: 'mcp' },
    schema: { body: openOnPurpose() },
    handler: async (request, reply) => {
      const { status, body } = await handleMcpMessage(request.body, {
        scope: request.user?.scope,
        log: request.log,
        cliBaseUrl: () => requestCliBaseUrl(request),
      });
      if (body === null) {
        reply.code(status).send();
        return;
      }
      reply.code(status).type('application/json').send(body);
    },
  });

  // No SSE stream (GET) and no session teardown (DELETE) — stateless mode.
  const methodNotAllowed = async (request, reply) => {
    reply.header('Allow', 'POST');
    throw createAppError('METHOD_NOT_ALLOWED', 'The Wisp MCP endpoint is stateless: send JSON-RPC messages with POST');
  };
  fastify.get('/mcp', { config: { auth: 'mcp', answers: 'mcp' }, handler: methodNotAllowed });
  fastify.delete('/mcp', { config: { auth: 'mcp', answers: 'mcp' }, handler: methodNotAllowed });
}
