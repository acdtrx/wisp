/**
 * Wisp's development log format, shared by the backend and its CLI scripts:
 * compact single-line pino-pretty with local time. Production logs stay plain
 * JSON lines (journald) — no transport. pino-pretty is a devDependency, absent
 * from production installs (`npm ci --omit=dev`), so only name it in dev.
 */
export const DEV_LOG_TRANSPORT = {
  target: 'pino-pretty',
  options: {
    translateTime: 'SYS:HH:MM:ss.l',
    singleLine: true,
    ignore: 'pid,hostname,reqId,req.host,req.remoteAddress,req.remotePort',
  },
};
