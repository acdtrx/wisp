/**
 * Tracking for live WebSocket consoles so we can force-close them on events
 * that invalidate prior auth (password change). Without this, a console open
 * before the password rotated would keep serving until the operator
 * disconnected, even though new connections would (correctly) be rejected.
 */
const liveSockets = new Set();

export function trackWebSocket(socket) {
  liveSockets.add(socket);
  socket.on('close', () => liveSockets.delete(socket));
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
