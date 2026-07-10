/**
 * MCP endpoint (streamable HTTP, stateless, POST-only). Auth is enforced by
 * the global auth hook: /mcp accepts ONLY bearer API tokens — cookies are
 * ignored entirely, which also makes the endpoint CSRF-irrelevant. The token's
 * scope rides on request.user and gates which tools are listed/callable.
 */
import { handleMcpMessage } from '../lib/mcp/mcpServer.js';

export default async function mcpRoutes(fastify) {
  fastify.post('/mcp', { schema: { hide: true } }, async (request, reply) => {
    const { status, body } = await handleMcpMessage(request.body, {
      scope: request.user?.scope,
      log: request.log,
    });
    if (body === null) {
      reply.code(status).send();
      return;
    }
    reply.code(status).type('application/json').send(body);
  });

  // No SSE stream (GET) and no session teardown (DELETE) — stateless mode.
  const methodNotAllowed = async (request, reply) => {
    reply
      .code(405)
      .header('Allow', 'POST')
      .send({ error: 'Method not allowed', detail: 'The Wisp MCP endpoint is stateless: POST JSON-RPC messages to /mcp' });
  };
  fastify.get('/mcp', { schema: { hide: true } }, methodNotAllowed);
  fastify.delete('/mcp', { schema: { hide: true } }, methodNotAllowed);
}
