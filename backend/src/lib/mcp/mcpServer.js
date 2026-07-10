/**
 * Minimal MCP server — streamable HTTP transport in stateless single-JSON-
 * response mode (the spec allows a plain application/json response per POST;
 * no SSE stream, no session ids, no server-initiated messages). Tools-only:
 * initialize / ping / tools/list / tools/call, notifications accepted with 202.
 * Hand-rolled on purpose (no SDK dependency) — same precedent as the in-house
 * JWT and OIDC implementations.
 *
 * Auth happens BEFORE this layer: the global auth hook admits only bearer API
 * tokens to /mcp and passes the token scope in. Per-tool scope is enforced
 * here (tools/list hides what the token can't call; tools/call double-checks).
 */
import { getCurrentVersion } from '../wispUpdate.js';
import { allTools } from './tools/index.js';

const PROTOCOL_VERSION = '2025-06-18';

const SERVER_INSTRUCTIONS =
  'Wisp manages virtual machines (KVM/QEMU via libvirt) and OCI containers (containerd) on this single ' +
  'Linux host. Containers sit directly on the host bridge with their own DHCP LAN IPs — there is no NAT ' +
  'or port mapping. Start with get_deployment_overview to map what runs here, then get_container / ' +
  'get_vm for detail. App containers (Caddy reverse proxy, zot registry, …) expose their configuration ' +
  'as metadata.appConfig on get_container — read a Caddy container\'s appConfig.hosts to see which ' +
  'subdomains are exposed and where they route. Secret values are always masked.';

// JSON-RPC 2.0 error codes. Parse errors (-32700) never reach this layer —
// Fastify rejects malformed JSON bodies at the content-type parser.
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function toolsForScope(scope) {
  if (scope === 'admin') return allTools;
  return allTools.filter((t) => t.scope === 'read');
}

function toolResult(id, data) {
  return rpcResult(id, {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  });
}

function toolError(id, err) {
  const payload = {
    error: err?.message ?? 'Tool failed',
    detail: err?.raw ?? err?.message ?? 'Unknown error',
    ...(err?.code ? { code: err.code } : {}),
  };
  return rpcResult(id, {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError: true,
  });
}

/**
 * Handle one MCP message. Returns { status, body } for the HTTP layer;
 * body === null means "no content" (notifications get 202 Accepted).
 */
export async function handleMcpMessage(message, { scope, log }) {
  if (Array.isArray(message)) {
    return { status: 200, body: rpcError(null, INVALID_REQUEST, 'JSON-RPC batching is not supported') };
  }
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return { status: 200, body: rpcError(message?.id, INVALID_REQUEST, 'Not a JSON-RPC 2.0 message') };
  }

  const { id, method, params } = message;

  // No id → notification (notifications/initialized, notifications/cancelled, …).
  // Stateless server: acknowledge and move on.
  if (id === undefined || id === null) {
    return { status: 202, body: null };
  }

  switch (method) {
    case 'initialize':
      return {
        status: 200,
        body: rpcResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'wisp', title: 'Wisp', version: getCurrentVersion() },
          instructions: SERVER_INSTRUCTIONS,
        }),
      };

    case 'ping':
      return { status: 200, body: rpcResult(id, {}) };

    case 'tools/list':
      return {
        status: 200,
        body: rpcResult(id, {
          tools: toolsForScope(scope).map(({ name, title, description, inputSchema }) => ({
            name, title, description, inputSchema,
          })),
        }),
      };

    case 'tools/call': {
      const name = params?.name;
      const tool = allTools.find((t) => t.name === name);
      if (!tool) {
        return { status: 200, body: rpcError(id, INVALID_PARAMS, `Unknown tool: ${String(name)}`) };
      }
      if (tool.scope !== 'read' && scope !== 'admin') {
        return { status: 200, body: toolError(id, { message: 'Insufficient scope', raw: `Tool "${tool.name}" requires an admin-scoped API token` }) };
      }
      try {
        const data = await tool.handler(params?.arguments ?? {});
        return { status: 200, body: toolResult(id, data) };
      } catch (err) {
        log?.warn({ err: err.message, code: err.code, tool: tool.name }, 'MCP tool failed');
        return { status: 200, body: toolError(id, err) };
      }
    }

    default:
      return { status: 200, body: rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`) };
  }
}
