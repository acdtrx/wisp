/**
 * Tells systemd the backend is ready (wisp.service is `Type=notify`): its start
 * then succeeds, and `systemctl start` returns, only once the backend listens,
 * migrations and boot work done — the updater's and the installer's gate. Node
 * has no unix datagram socket, so the message goes through systemd's own
 * `systemd-notify` (NotifyAccess=all lets a child send it; since systemd 246 it
 * waits until systemd has taken the message). Without NOTIFY_SOCKET (the Mac,
 * `wispctl local`, a shell) there is no one to tell.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { createAppError } from './routeErrors.js';

const execFileAsync = promisify(execFile);

/* A local datagram and systemd's acknowledgement: seconds would be a fault. */
const NOTIFY_TIMEOUT_MS = 10_000;

export async function notifySystemdReady() {
  if (!process.env.NOTIFY_SOCKET) return false;
  try {
    await execFileAsync('systemd-notify', ['--ready'], { timeout: NOTIFY_TIMEOUT_MS });
  } catch (err) {
    throw createAppError('SYSTEMD_NOTIFY_FAILED', `systemd-notify --ready failed: ${err.stderr?.trim() || err.message}`);
  }
  return true;
}
