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

const app = Fastify({ logger: true, forceCloseConnections: true });

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
  },
});

await app.register(httpProxy, {
  upstream: BACKEND_URL.replace('http', 'ws'),
  prefix: '/ws',
  rewritePrefix: '/ws',
  websocket: true,
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
