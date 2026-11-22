/**
 * The one way the backend runs something as root: `sudo -n <command> …args`,
 * for the commands setup's sudoers rules name — Wisp's helpers, installed in
 * /usr/local/bin (helperPath), and the updater's `systemctl start`.
 *
 * - Always through sudo, never by a direct exec; `-n`, so a missing rule fails
 *   at once instead of waiting for a password. `LC_ALL=C`, so sudo's own
 *   messages read the same on every host.
 * - A time bound is required: `timeoutMs` (the whole run) and/or `stallMs` (no
 *   output for that long). Past it, or on `signal`'s abort, sudo gets SIGTERM
 *   (it relays it to the command), and SIGKILL `graceMs` later; the call
 *   settles then at the latest.
 * - A failure is a PrivilegedError whose `reason` says which it was:
 *   `missing` (the command is not there: setup has not installed it),
 *   `refused` (sudo refused: no rule for it), `timed-out`, `aborted`, or
 *   `failed` (the command's own non-zero exit; `exitCode`, `stderr`).
 *   Callers answer with their own codes.
 */
import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';

/** Where setup installs Wisp's helpers, the paths its sudoers rules name. */
export const HELPER_DIR = '/usr/local/bin';

/** The installed path of the helper `name` (e.g. `wisp-mount`). */
export function helperPath(name) {
  return `${HELPER_DIR}/${name}`;
}

const RUN_SETUP = 'run setup (sudo scripts/linux/setup/common-steps.sh <install-dir> <deploy-user>)';
/** Output kept per stream: helpers answer in kilobytes; a runaway is cut, not buffered. */
const MAX_OUTPUT = 8 * 1024 * 1024;

export class PrivilegedError extends Error {
  constructor(reason, message, { command, exitCode = null, stdout = '', stderr = '' } = {}) {
    super(message);
    this.name = 'PrivilegedError';
    this.reason = reason;
    this.command = command;
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }

  /** The command's own words (stderr, else stdout), else the message: a caller's error detail. */
  get detail() {
    return (this.stderr || this.stdout || '').trim() || this.message;
  }
}

/**
 * sudo's refusal: it exits 1 and says so on stderr in its own words (LC_ALL=C) —
 * `sudo: a password is required` (no NOPASSWD rule for the command), or
 * `Sorry, user … is not allowed to execute …` (a rule that denies it). Only
 * those lines: sudo also prints warnings of its own and then runs the command
 * (`sudo: unable to resolve host …`), and a helper that then exits 1 failed
 * by itself.
 */
function isSudoRefusal(code, stderr) {
  return code === 1 && /^(?:sudo: a password is required|Sorry, user .* is not allowed to execute )/m.test(stderr);
}

/**
 * @param {string} command - absolute path of a command a sudoers rule names
 * @param {string[]} args
 * @param {{ timeoutMs?: number, stallMs?: number, graceMs?: number, signal?: AbortSignal,
 *   onStdoutLine?: (line: string) => void, onStderrLine?: (line: string) => void }} opts
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
export async function runPrivileged(command, args, opts = {}) {
  const { timeoutMs, stallMs, graceMs = 5_000, signal, onStdoutLine, onStderrLine } = opts;
  if (!Number.isFinite(timeoutMs) && !Number.isFinite(stallMs)) {
    throw new TypeError(`runPrivileged ${command}: a time bound (timeoutMs or stallMs) is required`);
  }
  try {
    await access(command, constants.X_OK);
  } catch {
    throw new PrivilegedError('missing', `${command} is not installed: ${RUN_SETUP}`, { command });
  }
  const what = `${command} ${args[0] ?? ''}`.trim();

  return new Promise((resolve, reject) => {
    const child = spawn('sudo', ['-n', command, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LC_ALL: 'C' },
    });
    let stdout = '';
    let stderr = '';
    let ended = null; // the bound that ended the run: 'timed-out' | 'aborted'
    let settled = false;
    let totalTimer = null;
    let stallTimer = null;
    let killTimer = null;

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      clearTimeout(stallTimer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const fail = (reason, message, exitCode = null) => finish(() => reject(new PrivilegedError(reason, message, { command, exitCode, stdout, stderr })));
    const stop = (reason, message) => {
      if (ended) return;
      ended = { reason, message };
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        fail(reason, message);
      }, graceMs);
    };
    const armStall = () => {
      if (!Number.isFinite(stallMs)) return;
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => stop('timed-out', `${what} gave no output for ${stallMs} ms and was stopped`), stallMs);
    };
    function onAbort() {
      stop('aborted', `${what} was stopped`);
    }

    const reader = (append, onLine) => {
      let partial = '';
      return (chunk) => {
        armStall();
        append(chunk);
        if (!onLine) return;
        const lines = (partial + chunk).split(/\r?\n/);
        partial = lines.pop();
        for (const line of lines) if (line.trim()) onLine(line.trim());
      };
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', reader((d) => { stdout = (stdout + d).slice(-MAX_OUTPUT); }, onStdoutLine));
    child.stderr.on('data', reader((d) => { stderr = (stderr + d).slice(-MAX_OUTPUT); }, onStderrLine));

    child.on('error', (err) => fail('failed', `${what} could not be started through sudo: ${err.message}`));
    child.on('close', (code) => {
      if (ended) return fail(ended.reason, ended.message);
      if (code === 0) return finish(() => resolve({ stdout, stderr }));
      if (isSudoRefusal(code, stderr)) {
        return fail('refused', `sudo refused ${command}: no sudoers rule lets the service run it; ${RUN_SETUP}`, code);
      }
      return fail('failed', `${what} failed (exit ${code})`, code);
    });

    if (Number.isFinite(timeoutMs)) {
      totalTimer = setTimeout(() => stop('timed-out', `${what} did not finish within ${timeoutMs} ms`), timeoutMs);
    }
    armStall();
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}
