import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import httpProxy from '@fastify/http-proxy';
import { loadRuntimeEnv } from './loadRuntimeEnv.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
loadRuntimeEnv(projectRoot);

const PORT = parseInt(process.env.WISP_FRONTEND_PORT, 10) || 8080;
const BACKEND_PORT = parseInt(process.env.WISP_BACKEND_PORT, 10) || 3001;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;

// trustProxy lets `request.protocol` reflect a TLS-terminating reverse proxy
// (Caddy/nginx) sitting in front of port 8080 via X-Forwarded-Proto. Limited
// to loopback so headers from arbitrary networks aren't trusted. Without this,
// an HTTPS reverse proxy would still surface as 'http' to the proxy header
// rewriter below, breaking the browser→proxy→frontend→backend Secure cookie
// chain.
const app = Fastify({
  logger: true,
  forceCloseConnections: true,
  trustProxy: ['127.0.0.1', '::1'],
});

// Inject standard X-Forwarded-* headers so the backend can derive the original
// browser-side scheme (for Secure cookie selection) and client IP (for the
// login rate-limit map). @fastify/http-proxy doesn't add these by default.
function rewriteProxiedHeaders(originalReq, headers) {
  return {
    ...headers,
    'x-forwarded-proto': originalReq.protocol,
    'x-forwarded-host': originalReq.headers.host || '',
    'x-forwarded-for': originalReq.ip,
  };
}

/* Baseline security headers attached to every HTML / API response served by
 * the frontend process. Backend SSE/WS responses go through `httpProxy` and
 * `reply.hijack()` — they bypass `onSend`, which is fine: SSE bodies are not
 * HTML and CSP doesn't apply to a JSON stream.
 *
 * `style-src 'unsafe-inline'` is required because xterm.js and noVNC inject
 * inline style attributes for terminal/canvas sizing; tightening this would
 * need either CSP nonces (complicates static caching) or hashes (brittle to
 * upstream updates). `img-src data:` covers favicons / inline data URIs used
 * by lucide-react icons. `connect-src 'self'` permits the same-origin WS
 * upgrade to /ws.
 *
 * `Strict-Transport-Security` is intentionally not set here — Wisp is often
 * deployed on HTTP behind a LAN; let the operator's reverse proxy enforce
 * HSTS where TLS termination actually lives. */
const CSP =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "font-src 'self' data:; " +
  "connect-src 'self'; " +
  "frame-ancestors 'none'; " +
  "base-uri 'self'; " +
  "form-action 'self'";

app.addHook('onSend', async (_request, reply, payload) => {
  reply.header('Content-Security-Policy', CSP);
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'same-origin');
  return payload;
});

// When backend is down, return 503 with a clear message instead of 500
app.setErrorHandler((err, request, reply) => {
  const cause = err.cause || err;
  const isProxyRefused =
    err.code === 'FST_REPLY_FROM_INTERNAL_SERVER_ERROR' ||
    cause.code === 'ECONNREFUSED' ||
    cause.code === 'ECONNRESET' ||
    (err.message && err.message.includes('ECONNREFUSED'));
  if (isProxyRefused && (request.url.startsWith('/api') || request.url.startsWith('/ws'))) {
    reply.code(503).send({
      error: 'Backend unavailable',
      code: 'BACKEND_UNREACHABLE',
      message: `Cannot reach backend at ${BACKEND_URL}. Is the Wisp backend running? (e.g. cd backend && npm run dev)`,
    });
    return;
  }
  reply.send(err);
});

// Undici defaults bodyTimeout between chunks (~10s). Long SSE streams (e.g. container
// create / image pull) send no events for minutes — disable timeout on proxied responses.
await app.register(httpProxy, {
  upstream: BACKEND_URL,
  prefix: '/api',
  rewritePrefix: '/api',
  websocket: false,
  replyOptions: {
    timeout: 0,
    rewriteRequestHeaders: rewriteProxiedHeaders,
  },
});

// Forward the browser's Origin and Host headers across the WS upgrade hop.
// @fastify/http-proxy's default rewriter only carries the cookie; without
// these two, the backend's same-origin Origin check (isAllowedWsOrigin) sees
// no Origin and rejects with 1008. Cookie still has to be forwarded too.
function forwardWsHeaders(headers, request) {
  const out = { ...headers };
  if (request.headers.cookie) out.cookie = request.headers.cookie;
  if (request.headers.origin) out.origin = request.headers.origin;
  if (request.headers.host) out.host = request.headers.host;
  return out;
}

await app.register(httpProxy, {
  upstream: BACKEND_URL.replace('http', 'ws'),
  prefix: '/ws',
  rewritePrefix: '/ws',
  websocket: true,
  wsClientOptions: {
    rewriteRequestHeaders: forwardWsHeaders,
  },
});

const distPath = resolve(__dirname, 'dist');
const publicPath = resolve(__dirname, 'public');

// Serve /vendor/* from public so noVNC is always available (dist may not include it in all deploy flows)
await app.register(fastifyStatic, {
  root: resolve(publicPath, 'vendor'),
  prefix: '/vendor/',
  decorateReply: false,
});

await app.register(fastifyStatic, {
  root: distPath,
  wildcard: false,
});

const indexHtml = readFileSync(resolve(distPath, 'index.html'), 'utf-8');

app.setNotFoundHandler((request, reply) => {
  if (request.url.startsWith('/api') || request.url.startsWith('/ws')) {
    reply.code(404).send({ error: 'Not found' });
    return;
  }
  reply.type('text/html').send(indexHtml);
});

async function start() {
  await app.listen({ port: PORT, host: '0.0.0.0' });
}

async function shutdown(signal) {
  app.log.info(`Received ${signal}, shutting down`);
  if (typeof app.server.closeAllConnections === 'function') {
    app.server.closeAllConnections();
  }
  await app.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start().catch((err) => {
  console.error('Failed to start frontend server:', err);
  process.exit(1);
});
