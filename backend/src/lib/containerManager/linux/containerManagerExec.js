/**
 * Interactive exec into a running container via containerd Tasks.Exec (PTY + named pipes).
 */
import { join } from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { constants as fsConstants, open as openFd } from 'node:fs';
import { Socket } from 'node:net';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

import {
  containerError,
  getClient,
  callUnary,
  packAny,
} from './containerManagerConnection.js';
import { getContainerDir, getContainersPath } from './containerPaths.js';
import { getTaskState, normalizeTaskStatus } from './containerManagerLifecycle.js';

const OCI_PROCESS_TYPE_URL = 'types.containerd.io/opencontainers/runtime-spec/1/Process';

/** Same capability set as main container process (containerManagerSpec.js). */
const DEFAULT_CAPS = [
  'CAP_CHOWN', 'CAP_DAC_OVERRIDE', 'CAP_FSETID', 'CAP_FOWNER',
  'CAP_MKNOD', 'CAP_NET_RAW', 'CAP_SETGID', 'CAP_SETUID',
  'CAP_SETFCAP', 'CAP_SETPCAP', 'CAP_NET_BIND_SERVICE',
  'CAP_SYS_CHROOT', 'CAP_KILL', 'CAP_AUDIT_WRITE',
];

const SIGKILL = 9;
/** Bound on reaping a SIGKILLed console exec before DeleteProcess (the shim reaps within ms). */
const CONSOLE_EXEC_REAP_TIMEOUT_MS = 5000;

/**
 * FIFO paths for Tasks.Exec must live on a filesystem both this process and containerd can see.
 * `os.tmpdir()` often points at systemd PrivateTmp for the Wisp unit, so containerd (real `/tmp`) would stat a different tree → "no such file".
 */
function getExecFifoSessionDir() {
  return join(getContainersPath(), '.exec-sessions');
}

/**
 * Tasks.Exec stdio paths must be absolute host paths. The shim uses them with os.Stat/open;
 * `file://` URIs are not stripped here (unlike some LogURI helpers), so `file:///var/...`
 * is treated as a relative path and stat fails with "no such file".
 */
function makeFifo(path) {
  execFileSync('mkfifo', ['-m', '0600', path], { encoding: 'utf8' });
}

/**
 * @param {boolean} runAsRoot
 * @returns {{ uid: number, gid: number }}
 */
function uidGidForExec(runAsRoot) {
  const deployUid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const deployGid = typeof process.getgid === 'function' ? process.getgid() : 0;
  if (runAsRoot) return { uid: 0, gid: 0 };
  return { uid: deployUid, gid: deployGid };
}

/**
 * @param {{ uid: number, gid: number }} u
 */
function buildExecProcessSpec(u) {
  return {
    terminal: true,
    user: { uid: u.uid, gid: u.gid },
    args: ['/bin/sh'],
    env: [
      'TERM=xterm-256color',
      'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    ],
    cwd: '/',
    capabilities: {
      bounding: DEFAULT_CAPS,
      effective: DEFAULT_CAPS,
      permitted: DEFAULT_CAPS,
    },
  };
}

async function readContainerRunAsRoot(name) {
  const dir = getContainerDir(name);
  try {
    const raw = await readFile(join(dir, 'container.json'), 'utf8');
    const config = JSON.parse(raw);
    return !!config.runAsRoot;
  } catch {
    throw containerError('CONTAINER_NOT_FOUND', `Container "${name}" not found`);
  }
}

/**
 * Open our end of an exec FIFO as a non-blocking fd in a net.Socket, polled by the event loop.
 * Never an fs stream: its open()/read() pin a libuv threadpool thread while the other end is
 * absent or idle (docs/spec/CONTAINERS.md — Exec FIFO I/O).
 *
 * The opens never block, so callers open our ends **before** `Tasks.Start`; the shim's blocking
 * opens of the other ends (during Start) then find a partner and return at once.
 * - `read`: O_RDONLY|O_NONBLOCK succeeds with no writer; Linux reports no EOF until a writer has
 *   been seen, then EOF when the shim's last writer closes.
 * - `write`: O_WRONLY|O_NONBLOCK would fail with ENXIO until the shim's reader exists, so O_RDWR —
 *   never blocks, and the shim's reader finds a writer. The read half is never read
 *   (`readable: false`); closing the socket gives the shim EOF on stdin.
 * @param {string} path
 * @param {'read' | 'write'} mode
 * @returns {Promise<Socket>}
 */
function openFifoSocket(path, mode) {
  const flags = (mode === 'read' ? fsConstants.O_RDONLY : fsConstants.O_RDWR) | fsConstants.O_NONBLOCK;
  return new Promise((resolve, reject) => {
    openFd(path, flags, (err, fd) => {
      if (err) reject(err);
      else resolve(new Socket({ fd, readable: mode === 'read', writable: mode === 'write' }));
    });
  });
}

/**
 * Start an interactive /bin/sh exec session with a PTY. Caller must invoke cleanupSession when done.
 * @param {string} name - Container id
 * @param {{ cols?: number, rows?: number }} [opts]
 * @returns {Promise<{
 *   execId: string,
 *   stdin: import('node:net').Socket,
 *   stdout: import('node:net').Socket,
 *   cleanupSession: () => Promise<void>,
 * }>}
 */
export async function execInContainer(name, opts = {}) {
  const cols = Math.max(1, Math.min(4096, Number(opts.cols) || 80));
  const rows = Math.max(1, Math.min(4096, Number(opts.rows) || 24));

  const task = await getTaskState(name);
  if (!task || normalizeTaskStatus(task.status) !== 'RUNNING') {
    throw containerError('CONTAINER_NOT_RUNNING', `Container "${name}" is not running`);
  }

  const runAsRoot = await readContainerRunAsRoot(name);
  const { uid, gid } = uidGidForExec(runAsRoot);
  const processSpec = buildExecProcessSpec({ uid, gid });

  const execId = `exec-${randomBytes(8).toString('hex')}`;
  const fifoRoot = getExecFifoSessionDir();
  await mkdir(fifoRoot, { recursive: true });
  const tmpDir = await mkdtemp(join(fifoRoot, 'wisp-exec-'));
  const stdinFifo = join(tmpDir, 'stdin');
  const stdoutFifo = join(tmpDir, 'stdout');

  /** @type {Socket | null} */
  let stdin = null;
  /** @type {Socket | null} */
  let stdout = null;
  let cleanupCalled = false;
  /** Tasks.Wait for the exec, armed once Start succeeded; settles when the shell exits. */
  let waitPromise = null;
  let exited = false;

  const cleanupSession = async () => {
    if (cleanupCalled) return;
    cleanupCalled = true;

    stdin?.destroy();
    stdout?.destroy();

    if (waitPromise && !exited) {
      /* Still running: DeleteProcess refuses a live exec (it would stay in the shim as a stopped
       * process), so SIGKILL it and let containerd reap it first — bounded, so a wedged shim
       * can't hold the teardown. */
      try {
        await callUnary(getClient('tasks'), 'kill', {
          containerId: name,
          execId,
          signal: SIGKILL,
          all: false,
        });
      } catch {
        /* exited between the check and the kill */
      }
      let reapTimer = null;
      await Promise.race([
        waitPromise.catch(() => { /* the wait outcome no longer matters; only that it settled */ }),
        new Promise((resolve) => { reapTimer = setTimeout(resolve, CONSOLE_EXEC_REAP_TIMEOUT_MS); }),
      ]);
      clearTimeout(reapTimer);
    }

    try {
      await callUnary(getClient('tasks'), 'deleteProcess', {
        containerId: name,
        execId,
      });
    } catch {
      /* already deleted, or Tasks.Exec never registered it */
    }

    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* temp dir may be busy briefly */
    }
  };

  try {
    makeFifo(stdinFifo);
    makeFifo(stdoutFifo);

    await callUnary(getClient('tasks'), 'exec', {
      containerId: name,
      execId,
      stdin: stdinFifo,
      stdout: stdoutFifo,
      stderr: '',
      terminal: true,
      spec: packAny(OCI_PROCESS_TYPE_URL, processSpec),
    });

    stdout = await openFifoSocket(stdoutFifo, 'read');
    stdin = await openFifoSocket(stdinFifo, 'write');

    await callUnary(getClient('tasks'), 'start', {
      containerId: name,
      execId,
    });
    waitPromise = callUnary(getClient('tasks'), 'wait', { containerId: name, execId });
    waitPromise.then(() => { exited = true; }, () => { /* cleanupSession only needs it settled */ });

    await callUnary(getClient('tasks'), 'resizePty', {
      containerId: name,
      execId,
      width: cols,
      height: rows,
    });

    return {
      execId,
      stdin,
      stdout,
      cleanupSession,
    };
  } catch (err) {
    await cleanupSession();
    throw err;
  }
}

/**
 * Run a non-interactive command inside a running container and return its output + exit code.
 * Unlike execInContainer (PTY-based interactive shell), this is fire-and-forget with captured output.
 * @param {string} name - Container id
 * @param {string[]} args - Command and arguments (e.g. ['caddy', 'reload', '--config', '/etc/caddy/Caddyfile'])
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>}
 */
export async function execCommandInContainer(name, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30000;

  const task = await getTaskState(name);
  if (!task || normalizeTaskStatus(task.status) !== 'RUNNING') {
    throw containerError('CONTAINER_NOT_RUNNING', `Container "${name}" is not running`);
  }

  const runAsRoot = await readContainerRunAsRoot(name);
  const { uid, gid } = uidGidForExec(runAsRoot);

  const processSpec = {
    terminal: false,
    user: { uid, gid },
    args,
    env: ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'],
    cwd: '/',
    capabilities: {
      bounding: DEFAULT_CAPS,
      effective: DEFAULT_CAPS,
      permitted: DEFAULT_CAPS,
    },
  };

  const execId = `cmd-${randomBytes(8).toString('hex')}`;
  const fifoRoot = getExecFifoSessionDir();
  await mkdir(fifoRoot, { recursive: true });
  const tmpDir = await mkdtemp(join(fifoRoot, 'wisp-cmd-'));
  const stdoutFifo = join(tmpDir, 'stdout');
  const stderrFifo = join(tmpDir, 'stderr');

  /** @type {Socket[]} */
  const readers = [];
  let waitPromise = null;
  let exited = false;
  let timer = null;

  const cleanup = async () => {
    clearTimeout(timer);
    if (waitPromise && !exited) {
      /* Still running (timed out, or output never drained): DeleteProcess refuses a live
       * process, so SIGKILL it and let containerd reap it before deleting. */
      try {
        await callUnary(getClient('tasks'), 'kill', { containerId: name, execId, signal: SIGKILL, all: false });
      } catch { /* exited between the timeout and the kill */ }
      await waitPromise.catch(() => { /* the wait outcome no longer matters; only that it settled */ });
    }
    try { await callUnary(getClient('tasks'), 'deleteProcess', { containerId: name, execId }); } catch { /* may already be deleted, or never started */ }
    for (const reader of readers) reader.destroy();
    try { await rm(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  };

  try {
    makeFifo(stdoutFifo);
    makeFifo(stderrFifo);

    await callUnary(getClient('tasks'), 'exec', {
      containerId: name,
      execId,
      stdin: '',
      stdout: stdoutFifo,
      stderr: stderrFifo,
      terminal: false,
      spec: packAny(OCI_PROCESS_TYPE_URL, processSpec),
    });

    // Our read ends first (non-blocking, see openFifoSocket): the shim opens the write ends during Start.
    readers.push(await openFifoSocket(stdoutFifo, 'read'));
    readers.push(await openFifoSocket(stderrFifo, 'read'));
    const stdoutChunks = [];
    const stderrChunks = [];

    const collectStream = (s, chunks) => new Promise((resolve, reject) => {
      s.on('data', (d) => chunks.push(d));
      s.on('end', () => resolve());
      s.on('error', reject);
    });

    /* Observed from the start so a stream error after a failed Start or a timeout is never an
     * unhandled rejection; a read error only truncates the captured output. */
    const outputDone = Promise.all([
      collectStream(readers[0], stdoutChunks),
      collectStream(readers[1], stderrChunks),
    ]).catch(() => { /* partial output is still returned */ });

    await callUnary(getClient('tasks'), 'start', { containerId: name, execId });

    waitPromise = callUnary(getClient('tasks'), 'wait', { containerId: name, execId });
    waitPromise.then(() => { exited = true; }, () => { /* surfaced by the await below */ });

    // The process has exited and both FIFOs hit EOF — the timeout bounds the whole run.
    const finished = Promise.all([waitPromise, outputDone]);
    const [waitResult] = timeoutMs > 0
      ? await Promise.race([
        finished,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(containerError('CONTAINERD_ERROR', `Command in container "${name}" timed out after ${timeoutMs} ms`)),
            timeoutMs,
          );
        }),
      ])
      : await finished;

    const exitCode = Number(waitResult?.exitStatus ?? waitResult?.exit_status ?? -1);
    const stdout = Buffer.concat(stdoutChunks).toString('utf8');
    const stderr = Buffer.concat(stderrChunks).toString('utf8');

    await cleanup();
    return { exitCode, stdout, stderr };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/**
 * Resize the PTY for an exec session.
 * @param {string} name
 * @param {string} execId
 * @param {number} cols
 * @param {number} rows
 */
export async function resizeExec(name, execId, cols, rows) {
  const w = Math.max(1, Math.min(4096, Math.floor(Number(cols) || 80)));
  const h = Math.max(1, Math.min(4096, Math.floor(Number(rows) || 24)));
  await callUnary(getClient('tasks'), 'resizePty', {
    containerId: name,
    execId,
    width: w,
    height: h,
  });
}
