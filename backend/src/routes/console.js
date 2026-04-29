import { createConnection } from 'node:net';
import { getVNCPort } from '../lib/vmManager.js';
import { validateVMName } from '../lib/validation.js';
import { isAllowedWsOrigin } from '../lib/wsOrigin.js';
import { trackWebSocket } from '../lib/wsTracking.js';

export default async function consoleRoutes(fastify) {
  // VNC: TCP proxy to QEMU VNC port. Auth already handled by the global
  // onRequest hook (cookie-based JWT) — by the time we run, request.user is
  // set. The Origin check below stops cross-origin pages from opening this WS
  // even with a stolen cookie (CORS does not apply to WebSocket).
  fastify.get('/console/:name/vnc', { websocket: true }, async (socket, request) => {
    const { name } = request.params;
    const log = request.log.child({ scope: 'vnc-console', vmName: name });

    if (!isAllowedWsOrigin(request)) {
      log.warn({ reason: 'origin_not_allowed', origin: request.headers?.origin }, 'VNC WebSocket rejected');
      socket.close(1008, 'origin not allowed');
      return;
    }

    trackWebSocket(socket);

    try {
      validateVMName(name);
    } catch (err) {
      log.warn({ reason: 'invalid_vm_name', err: err.message }, 'VNC WebSocket rejected');
      socket.close(4000, err.message || 'Invalid VM name');
      return;
    }
    let port;
    try {
      port = await getVNCPort(name);
    } catch (err) {
      log.warn(
        {
          reason: 'get_vnc_port_failed',
          code: err.code ?? 'UNKNOWN',
          message: err.message,
          detail: err.raw,
        },
        'VNC could not resolve graphics port (libvirt/XML or VM state)',
      );
      socket.close(4000, err.message || 'VNC not available');
      return;
    }

    log.info({ port }, 'VNC opening TCP to QEMU');

    const sock = createConnection(port, '127.0.0.1', () => {
      log.info({ port }, 'VNC TCP connected to QEMU');
    });

    sock.on('data', (data) => {
      if (socket.readyState === 1) socket.send(data);
    });
    sock.on('error', (err) => {
      log.warn(
        {
          reason: 'qemu_tcp_error',
          message: err.message,
          code: err.code,
          errno: err.errno,
          syscall: err.syscall,
        },
        'VNC TCP socket error (QEMU side)',
      );
      if (socket.readyState === 1) socket.close(1011, 'TCP error');
    });
    sock.on('close', (hadError) => {
      log.info({ port, hadError }, 'VNC TCP to QEMU closed');
      if (socket.readyState === 1) socket.close();
    });

    socket.on('message', (data) => {
      if (!sock.destroyed) sock.write(data);
    });
    socket.on('close', (code, reason) => {
      log.info(
        {
          port,
          wsCloseCode: code,
          wsCloseReason: typeof reason === 'string' ? reason : reason?.toString?.() ?? '',
        },
        'VNC WebSocket closed',
      );
      sock.destroy();
    });
    socket.on('error', (err) => {
      log.warn({ reason: 'websocket_error', message: err?.message }, 'VNC WebSocket error');
      sock.destroy();
    });
  });
}
