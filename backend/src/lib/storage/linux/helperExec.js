/**
 * Run the wisp-mount helper (through sudo unless already root) with a timeout
 * that settles on its own timer (CODING-RULES §6). execFile's `timeout` signals
 * sudo; a child the helper started keeps the stdout pipe open on a host whose
 * sudo hands it the pipe (no `use_pty`), so the promise would wait for that
 * child. This rejects `graceMs` after the timeout regardless, killing what is
 * left; the helper also bounds its own mount/umount (backend/scripts/wisp-mount).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function execHelper(scriptPath, args, { timeout, graceMs = 5_000 }) {
  const isRoot = process.getuid && process.getuid() === 0;
  const pending = isRoot
    ? execFileAsync(scriptPath, args, { timeout })
    : execFileAsync('sudo', ['-n', scriptPath, ...args], { timeout });
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      pending.child?.kill('SIGKILL');
      const err = new Error(`${scriptPath} ${args[0]} did not finish within ${timeout} ms`);
      err.killed = true;
      reject(err);
    }, timeout + graceMs);
  });
  pending.catch(() => {}); // settled by the race below; a late rejection is not unhandled
  return Promise.race([pending, deadline]).finally(() => clearTimeout(timer));
}
