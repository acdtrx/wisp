/**
 * Tracking for live WebSocket consoles so we can force-close them on events
 * that invalidate prior auth (password change). Without this, a console open
 * before the password rotated would keep serving until the operator
 * disconnected, even though new connections would (correctly) be rejected.
 */
const liveSockets = new Set();

/*
 * CODING-RULES §6: a console's sockets live as
 * long as the user keeps it open, so there is no total cap — but a peer that
 * vanished without a close (laptop lid, dropped VPN) would leave the socket,
 * and the VNC TCP leg or container exec session behind it, open for good. Each
 * tracked socket is pinged every 30 s; one that hasn't answered the previous
 * ping is terminated, and its close tears down what it carried.
 */
export const WS_PING_INTERVAL_MS = 30_000;

export function trackWebSocket(socket, { pingIntervalMs = WS_PING_INTERVAL_MS } = {}) {
  liveSockets.add(socket);
  let alive = true;
  socket.on('pong', () => { alive = true; });
  const timer = setInterval(() => {
    if (!alive) {
      socket.terminate();
      return;
    }
    alive = false;
    try {
      socket.ping();
    } catch {
      /* socket tearing down */
    }
  }, pingIntervalMs);
  timer.unref?.();
  socket.on('close', () => {
    clearInterval(timer);
    liveSockets.delete(socket);
  });
}

export function closeAllWebSockets(reason = 'auth invalidated') {
  for (const socket of [...liveSockets]) {
    try {
      socket.close(1008, reason);
    } catch {
      /* socket may already be tearing down */
    }
  }
  liveSockets.clear();
}
