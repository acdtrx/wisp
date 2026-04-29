/**
 * WebSocket: interactive shell in a running container (containerd exec + PTY).
 */
import { execInContainer, resizeExec } from '../lib/containerManager.js';
import { validateContainerName } from '../lib/validation.js';
import { isAllowedWsOrigin } from '../lib/wsOrigin.js';
import { trackWebSocket } from '../lib/wsTracking.js';

/** RFC 6455: close reason must be ≤123 bytes UTF-8; `ws` throws RangeError if longer. */
const WS_CLOSE_REASON_MAX_BYTES = 123;

function wsCloseReason(detail, fallback = 'Error') {
  let s = detail != null && String(detail).trim() !== '' ? String(detail) : fallback;
  if (Buffer.byteLength(s, 'utf8') <= WS_CLOSE_REASON_MAX_BYTES) return s;
  while (s.length > 0 && Buffer.byteLength(s, 'utf8') > WS_CLOSE_REASON_MAX_BYTES) {
    s = s.slice(0, -1);
  }
  return s || fallback;
}

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
    /* not JSON */
  }
  return null;
}

export default async function containerConsoleRoutes(fastify) {
  fastify.get('/container-console/:name', { websocket: true }, async (socket, request) => {
    const { name } = request.params;
    const log = request.log.child({ scope: 'container-console', containerName: name });

    if (!isAllowedWsOrigin(request)) {
      log.warn({ reason: 'origin_not_allowed', origin: request.headers?.origin }, 'Container console WebSocket rejected');
      socket.close(1008, 'origin not allowed');
      return;
    }

    trackWebSocket(socket);

    try {
      validateContainerName(name);
    } catch (err) {
      log.warn({ reason: 'invalid_container_name', err: err.message }, 'Container console WebSocket rejected');
      socket.close(4000, wsCloseReason(err.message, 'Invalid container name'));
      return;
    }

    const cols = Math.max(1, Math.min(4096, parseInt(request.query.cols, 10) || 80));
    const rows = Math.max(1, Math.min(4096, parseInt(request.query.rows, 10) || 24));

    let session;
    try {
      session = await execInContainer(name, { cols, rows });
    } catch (err) {
      log.warn(
        { reason: 'exec_failed', code: err.code, message: err.message, detail: err.raw },
        'Container exec failed',
      );
      socket.close(4000, wsCloseReason(err.message, 'Exec failed'));
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

    stdout.on('data', (chunk) => {
      if (socket.readyState === 1) {
        socket.send(chunk);
      }
    });

    stdout.on('end', () => {
      log.info({ execId }, 'Container exec stdout ended');
      if (socket.readyState === 1) socket.close();
    });

    stdout.on('error', (err) => {
      log.warn({ err: err.message, execId }, 'Container exec stdout error');
      if (socket.readyState === 1) socket.close(1011, 'stdout error');
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
  });
}
