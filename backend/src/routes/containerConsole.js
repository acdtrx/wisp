/**
 * WebSocket: interactive shell in a running container (containerd exec + PTY).
 */
import { execInContainer, resizeExec } from '../lib/containerManager/index.js';
import { isAllowedWsOrigin } from '../lib/wsOrigin.js';
import { trackWebSocket } from '../lib/wsTracking.js';
import { containerParamsSchema } from './schemas.js';

/* WS close reasons are sent to any network observer and to peer tabs. We keep
 * them as a small set of generic constants — the real error is in the server
 * log. RFC 6455 also requires the reason to be ≤123 bytes UTF-8, but the
 * generic strings stay well within that. */
const WS_CLOSE = {
  EXEC_FAILED: 'exec failed',
  SESSION_ENDED: 'session ended',
};

/**
 * Parse a text-frame resize control message. Returns null if not a resize payload.
 * @param {Buffer} buf
 */
function parseResizeControl(buf) {
  if (!buf || buf.length === 0 || buf.length > 1024) return null;
  const s = buf.toString('utf8');
  if (!s.startsWith('{')) return null;
  try {
    const o = JSON.parse(s);
    if (o?.type === 'resize' && Number.isFinite(o.cols) && Number.isFinite(o.rows)) {
      return { cols: Math.floor(o.cols), rows: Math.floor(o.rows) };
    }
  } catch {
    /* not JSON: terminal input, not a control message */
  }
  return null;
}

export default async function containerConsoleRoutes(fastify) {
  /* An invalid name or PTY size is refused by the schema, before the upgrade. */
  const ptySize = (fallback) => ({ type: 'integer', minimum: 1, maximum: 4096, default: fallback });
  fastify.get('/container-console/:name', {
    websocket: true,
    config: { auth: 'session', answers: 'websocket' },
    schema: {
      params: containerParamsSchema(),
      querystring: {
        type: 'object',
        properties: { cols: ptySize(80), rows: ptySize(24) },
        additionalProperties: false,
      },
    },
    handler: async (socket, request) => {
      const { name } = request.params;
      const log = request.log.child({ scope: 'container-console', containerName: name });

      if (!isAllowedWsOrigin(request)) {
        log.warn(
          { reason: 'origin_not_allowed', origin: request.headers?.origin, host: request.headers?.host },
          'Container console WebSocket rejected',
        );
        socket.close(1008, 'origin not allowed');
        return;
      }

      trackWebSocket(socket);

      const { cols, rows } = request.query;

      let session;
      try {
        session = await execInContainer(name, { cols, rows });
      } catch (err) {
        log.warn(
          { reason: 'exec_failed', code: err.code, message: err.message, detail: err.raw },
          'Container exec failed',
        );
        socket.close(4000, WS_CLOSE.EXEC_FAILED);
        return;
      }

      const { execId, stdin, stdout, cleanupSession } = session;

      const safeCleanup = async () => {
        try {
          await cleanupSession();
        } catch (e) {
          log.warn({ err: e?.message }, 'Container console cleanup error');
        }
      };

      /* The WS 'close' event fires once; if the client left during exec setup, a listener
       * attached now would never run and the shell would stay alive in the container. */
      if (socket.readyState !== socket.OPEN) {
        log.info({ execId }, 'Container console WebSocket closed during exec setup');
        await safeCleanup();
        return;
      }

      stdout.on('data', (chunk) => {
        if (socket.readyState === 1) {
          socket.send(chunk);
        }
      });

      stdout.on('end', () => {
        log.info({ execId }, 'Container exec stdout ended');
        /* 1000 = the shell exited; the client shows "Session ended" instead of reconnecting. */
        if (socket.readyState === 1) socket.close(1000, WS_CLOSE.SESSION_ENDED);
      });

      stdout.on('error', (err) => {
        log.warn({ err: err.message, execId }, 'Container exec stdout error');
        if (socket.readyState === 1) socket.close(1011, 'stdout error');
      });

      stdin.on('error', (err) => {
        log.warn({ err: err.message, execId }, 'Container exec stdin error');
        if (socket.readyState === 1) socket.close(1011, 'stdin error');
      });

      socket.on('message', (data, isBinary) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (!isBinary) {
          const resize = parseResizeControl(buf);
          if (resize) {
            resizeExec(name, execId, resize.cols, resize.rows).catch((e) => {
              log.warn({ err: e?.message, execId }, 'resizePty failed');
            });
            return;
          }
          return;
        }
        if (!stdin.destroyed) stdin.write(buf);
      });

      socket.on('close', (code, reason) => {
        log.info(
          {
            execId,
            wsCloseCode: code,
            wsCloseReason: typeof reason === 'string' ? reason : reason?.toString?.() ?? '',
          },
          'Container console WebSocket closed',
        );
        void safeCleanup();
      });

      socket.on('error', (err) => {
        log.warn({ err: err?.message, execId }, 'Container console WebSocket error');
        void safeCleanup();
      });
    },
  });
}
