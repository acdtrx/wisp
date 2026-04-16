/**
 * Interactive exec into a running container via containerd Tasks.Exec (PTY + named pipes).
 */
import { join } from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
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
 * Open our side of the exec FIFOs (read stdout, write stdin).
 * Must run **concurrently** with `Tasks.Start`: the shim opens the other ends during Start; if we
 * open only after Start completes, both sides block on FIFO open and console copy hits DEADLINE_EXCEEDED.
 * @param {string} stdinPath
 * @param {string} stdoutPath
 * @returns {Promise<{ stdin: import('node:fs').WriteStream, stdout: import('node:fs').ReadStream }>}
 */
function openExecFifoStreams(stdinPath, stdoutPath) {
  return new Promise((resolve, reject) => {
    let stdin = null;
    let stdout = null;
    let pending = 2;
    let settled = false;

    const tryDone = (err) => {
      if (settled) return;
      if (err) {
        settled = true;
        try { stdin?.destroy(); } catch { /* best effort */ }
        try { stdout?.destroy(); } catch { /* best effort */ }
        reject(err);
        return;
      }
      pending -= 1;
      if (pending === 0 && stdin && stdout) {
        settled = true;
        resolve({ stdin, stdout });
      }
    };

    stdout = createReadStream(stdoutPath, { autoClose: true });
    stdin = createWriteStream(stdinPath, { autoClose: true });

    stdout.on('open', () => tryDone(null));
    stdin.on('open', () => tryDone(null));
    stdout.on('error', (e) => tryDone(e));
    stdin.on('error', (e) => tryDone(e));
  });
}

/**
 * Start an interactive /bin/sh exec session with a PTY. Caller must invoke cleanupSession when done.
 * @param {string} name - Container id
 * @param {{ cols?: number, rows?: number }} [opts]
 * @returns {Promise<{
 *   execId: string,
 *   stdin: import('node:fs').WriteStream,
 *   stdout: import('node:fs').ReadStream,
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

  let cleanupCalled = false;

  const cleanupSession = async () => {
    if (cleanupCalled) return;
    cleanupCalled = true;

    try {
      await callUnary(getClient('tasks'), 'kill', {
        containerId: name,
        execId,
        signal: SIGKILL,
        all: false,
      });
    } catch {
      /* process may already have exited */
    }

    try {
      await callUnary(getClient('tasks'), 'deleteProcess', {
        containerId: name,
        execId,
      });
    } catch {
      /* may already be deleted */
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

    const startPromise = callUnary(getClient('tasks'), 'start', {
      containerId: name,
      execId,
    });
    const streamsPromise = openExecFifoStreams(stdinFifo, stdoutFifo);
    const [, streams] = await Promise.all([startPromise, streamsPromise]);
    const { stdin, stdout } = streams;

    await callUnary(getClient('tasks'), 'resizePty', {
      containerId: name,
      execId,
      width: cols,
      height: rows,
    });

    const wrappedCleanup = async () => {
      try {
        stdin.destroy();
      } catch { /* best effort */ }
      try {
        stdout.destroy();
      } catch { /* best effort */ }
      await cleanupSession();
    };

    return {
      execId,
      stdin,
      stdout,
      cleanupSession: wrappedCleanup,
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

  const cleanup = async () => {
    try { await callUnary(getClient('tasks'), 'deleteProcess', { containerId: name, execId }); } catch { /* may already be deleted */ }
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

    // Start the exec and open FIFOs concurrently (shim opens the other end during Start)
    const startPromise = callUnary(getClient('tasks'), 'start', { containerId: name, execId });
    const stdoutChunks = [];
    const stderrChunks = [];

    const collectStream = (path, chunks) => new Promise((resolve, reject) => {
      const s = createReadStream(path, { autoClose: true });
      s.on('data', (d) => chunks.push(d));
      s.on('end', () => resolve());
      s.on('error', reject);
    });

    const stdoutDone = collectStream(stdoutFifo, stdoutChunks);
    const stderrDone = collectStream(stderrFifo, stderrChunks);

    await startPromise;

    // Wait for the exec process to exit
    const waitPromise = callUnary(getClient('tasks'), 'wait', { containerId: name, execId });

    const timer = timeoutMs > 0
      ? new Promise((_, reject) => setTimeout(() => reject(new Error('exec timed out')), timeoutMs))
      : null;
    const waitResult = timer
      ? await Promise.race([waitPromise, timer])
      : await waitPromise;

    // Streams should end once the process exits; give them a moment
    await Promise.all([stdoutDone, stderrDone]).catch(() => {});

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
